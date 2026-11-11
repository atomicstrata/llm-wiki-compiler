/**
 * Folder-qualified wikilink targets outside the viewer.
 *
 * `[[person/karl-marrett|Karl]]` and `[[timeline/2026-W45]]` name one page by its
 * exact directory and slug. Every other reader of links must agree with the
 * viewer about that, and the compile-side passes that rewrite concept pages must
 * never mangle one:
 *
 *   - the shared parser (`parseQualifiedTarget` / `wikilinkKey`) and the
 *     extractors and tokenizer built on it;
 *   - lint, which checks a qualified link against `wiki/<dir>/<slug>.md`, and
 *     the fix plan, which never retargets one by title;
 *   - link repair, interlink resolution and OKF export, which leave it verbatim.
 */

import { describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseQualifiedTarget, wikilinkKey } from "../src/wiki/wikilink-target.js";
import { extractWikilinkSlugs, extractWikilinkTargets } from "../src/wiki/collect.js";
import { recognizedWikilinkTargets } from "../src/wiki/wikilink-tokens.js";
import { checkBrokenWikilinks } from "../src/linter/rules.js";
import { planLintFixes } from "../src/linter/fix-plan.js";
import { repairLinks } from "../src/compiler/link-repair.js";
import { resolveLinks } from "../src/compiler/resolver.js";
import { wikilinksToOkf } from "../src/export/okf/mapping.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";

describe("parseQualifiedTarget and wikilinkKey", () => {
  it("reads dir/slug exactly, keeping case and dropping a heading", () => {
    expect(parseQualifiedTarget("person/karl-marrett")).toEqual({ directory: "person", slug: "karl-marrett" });
    expect(parseQualifiedTarget(" timeline/2026-W45#Monday ")).toEqual({ directory: "timeline", slug: "2026-W45" });
    expect(wikilinkKey("timeline/2026-11-05#Morning")).toBe("timeline/2026-11-05");
  });

  it("leaves anything that is not one lowercase directory and one slug a bare link", () => {
    for (const target of ["TCP/IP", "a/b/c", "/slug", "dir/", "../etc", "dir/../x", "dir/a.md", "Argo CD"]) {
      expect(parseQualifiedTarget(target)).toBeNull();
    }
    expect(wikilinkKey("TCP/IP")).toBe("tcpip");
    expect(wikilinkKey("Argo CD")).toBe("argo-cd");
  });

  it("gives the extractors and the tokenizer the same key", () => {
    const body = "[[person/karl-marrett|Karl]] met [[Argo CD]] on [[timeline/2026-11-05#Noon|Thursday]].";
    expect(extractWikilinkSlugs(body)).toEqual(["person/karl-marrett", "argo-cd", "timeline/2026-11-05"]);
    expect(extractWikilinkTargets(body)[0]).toEqual({ slug: "person/karl-marrett", display: "Karl" });
    expect(recognizedWikilinkTargets(body)).toEqual(["person/karl-marrett", "argo-cd", "timeline/2026-11-05"]);
  });
});

describe("lint on qualified links", () => {
  const ctx = useTempRoot(["wiki/timeline"]);

  /** A concept linking an existing day, a missing day, and a person page that is not there. */
  async function writeLinkingConcept(): Promise<void> {
    await writePage(path.join(ctx.dir, "wiki/timeline"), "2026-11-05", { title: "Thursday" }, "A day.");
    await writePage(path.join(ctx.dir, "wiki/concepts"), "alpha", { title: "Alpha", summary: "s" },
      "On [[timeline/2026-11-05|Thursday]] and [[timeline/2026-11-06]], [[person/nobody|Nobody]] said so.");
  }

  it("passes a qualified link whose page exists and reports one whose page does not", async () => {
    await writeLinkingConcept();
    const messages = (await checkBrokenWikilinks(ctx.dir)).map((result) => result.message);
    expect(messages).toEqual([
      "Broken wikilink [[timeline/2026-11-06]] — no matching page found",
      "Broken wikilink [[person/nobody|Nobody]] — no matching page found",
    ]);
  });

  it("never retargets a broken qualified link by title", async () => {
    await writeLinkingConcept();
    await writePage(path.join(ctx.dir, "wiki/concepts"), "people", { title: "person/nobody", summary: "s" }, "x");
    const plans = await planLintFixes(ctx.dir, "generic");
    expect(plans.map((plan) => plan.kind)).toEqual(["recommendation", "recommendation"]);
  });
});

describe("compile-side rewrites leave qualified links alone", () => {
  const ctx = useTempRoot(["wiki/timeline"]);
  const BODY = "Met [[person/karl-marrett|Karl Marrett]] on [[timeline/2026-11-05]].";

  it("link repair does not read a qualified target as a concept prefix", async () => {
    await writePage(path.join(ctx.dir, "wiki/concepts"), "alpha", { title: "Alpha" }, BODY);
    // Exactly the pages a slugified `person/karl-marrett` or `timeline/2026-11-05` would prefix.
    await writePage(path.join(ctx.dir, "wiki/concepts"), "personkarl-marrett-notes", { title: "Notes" }, "x");
    await writePage(path.join(ctx.dir, "wiki/concepts"), "timeline2026-11-05-recap", { title: "Recap" }, "x");
    expect(await repairLinks(ctx.dir)).toEqual([]);
  });

  it("interlink resolution does not link a title inside a qualified link", async () => {
    await writePage(path.join(ctx.dir, "wiki/concepts"), "alpha", { title: "Alpha" }, BODY);
    await writePage(path.join(ctx.dir, "wiki/concepts"), "karl-marrett", { title: "Karl Marrett" }, "x");
    await writePage(path.join(ctx.dir, "wiki/concepts"), "timeline", { title: "Timeline" }, "x");
    expect(await resolveLinks(ctx.dir, ["alpha"], [])).toEqual([]);
  });

  it("OKF export keeps a qualified link verbatim and still converts a bare one", () => {
    const resolve = (slug: string) => (slug === "alpha" || slug === "personkarl-marrett" ? { path: `${slug}.md`, title: slug } : null);
    expect(wikilinksToOkf("[[person/karl-marrett|Karl]] and [[alpha]]", resolve)).toBe("[[person/karl-marrett|Karl]] and [alpha](/alpha.md)");
  });
});

describe("a qualified directory that is not on disk", () => {
  const ctx = useTempRoot();

  it("is reported broken without failing the lint run", async () => {
    await mkdir(path.join(ctx.dir, "wiki/concepts"), { recursive: true });
    await writeFile(path.join(ctx.dir, "wiki/concepts/alpha.md"), "---\ntitle: Alpha\n---\n\nSee [[queries/why]].\n");
    expect((await checkBrokenWikilinks(ctx.dir)).map((result) => result.rule)).toEqual(["broken-wikilink"]);
  });
});
