/**
 * @file test/link-repair.test.ts
 * @description Repair of wikilinks whose target names an existing page too
 * briefly to resolve — `[[Argo CD]]` against `argo-cd-image-update-ownership-model`.
 * The pass must rewrite the TARGET only, never the surrounding prose, and must
 * refuse to guess: a slug prefixing two pages or none is left exactly as it is.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { writeFile, mkdir, readFile, symlink } from "fs/promises";
import path from "path";
import { execFileSync } from "node:child_process";
import { repairLinks } from "../src/compiler/link-repair.js";
import { applyCompilePageWritesLocked } from "../src/compiler/compile-write.js";
import { writeCandidate } from "../src/compiler/candidates.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { writePage as writeFixturePage } from "./fixtures/write-page.js";

describe("repairLinks", () => {
  const ctx = useTempRoot();
  let tmpDir: string;
  let conceptsDir: string;

  beforeEach(() => {
    tmpDir = ctx.dir;
    conceptsDir = path.join(tmpDir, "wiki", "concepts");
  });

  async function writePage(slug: string, body: string): Promise<void> {
    await writeFixturePage(conceptsDir, slug, { title: slug, summary: "test" }, body);
  }

  async function readPage(slug: string): Promise<string> {
    return readFile(path.join(conceptsDir, `${slug}.md`), "utf-8");
  }

  async function repairAndApply(): Promise<void> {
    await applyCompilePageWritesLocked(tmpDir, await repairLinks(tmpDir));
  }

  it("repoints a link to the single page its slug prefixes", async () => {
    await writePage("argo-cd-image-update-ownership-model", "Details.");
    await writePage("deployment", "Managed by [[Argo CD]] end to end.");

    await repairAndApply();

    expect(await readPage("deployment")).toContain(
      "[[argo-cd-image-update-ownership-model|Argo CD]]",
    );
  });

  it("preserves literal replacement sequences in page prose", async () => {
    await writePage("argo-cd-guide", "Details.");
    const prose = "Literal $$ $& $` $' then [[Argo CD]].";
    await writePage("deployment", prose);
    await repairAndApply();
    expect(await readPage("deployment")).toContain(prose.replace("[[Argo CD]]", "[[argo-cd-guide|Argo CD]]"));
  });

  it.each([
    "```md\n[[Argo CD]]\n```", "~~~md\n[[Argo CD]]\n~~~",
    "`[[Argo CD]]`", "``code ` [[Argo CD]]``", "    [[Argo CD]]",
    "> ```\n> [[Argo CD]]\n> ```", "\\` prose `[[Argo CD]]`",
  ])("preserves code examples: %s", async (example) => {
    await writePage("argo-cd-guide", "Details.");
    await writePage("deployment", `${example}\n\nProse [[Argo CD]].`);
    await repairAndApply();
    expect(await readPage("deployment")).toContain(`${example}\n\nProse [[argo-cd-guide|Argo CD]].`);
  });

  it("counts pending prefixes when refusing ambiguity", async () => {
    await writePage("argo-cd-guide", "Details.");
    await writePage("deployment", "See [[Argo CD]].");
    await writeCandidate(tmpDir, {
      slug: "argo-cd-ownership", title: "Ownership", summary: "Pending", sources: [], body: "Pending body.",
    });
    expect(await repairLinks(tmpDir)).toEqual([]);
  });

  it("does not collapse two live namespaces into one prefix candidate", async () => {
    await writePage("argo-cd-guide", "Details.");
    await writePage("deployment", "See [[Argo CD]].");
    const queries = path.join(tmpDir, "wiki/queries");
    await mkdir(queries, { recursive: true });
    await writeFile(path.join(queries, "argo-cd-guide.md"), "Query details.");
    expect(await repairLinks(tmpDir)).toEqual([]);
  });

  it("drops escaping pages before their bytes enter a write", async () => {
    await writePage("argo-cd-guide", "Details.");
    const outside = path.join(tmpDir, "outside.md");
    await writeFile(outside, "Secret [[Argo CD]].");
    await symlink(outside, path.join(conceptsDir, "escape.md"));
    expect(await repairLinks(tmpDir)).toEqual([]);
    expect(await readFile(outside, "utf8")).toBe("Secret [[Argo CD]].");
  });

  it.skipIf(process.platform === "win32")("drops a named pipe without blocking the repair pass", async () => {
    await writePage("argo-cd-guide", "Details.");
    execFileSync("mkfifo", [path.join(conceptsDir, "pipe.md")]);
    expect(await repairLinks(tmpDir)).toEqual([]);
  }, 2_000);

  it("keeps the displayed text byte-identical", async () => {
    await writePage("alembic-database-migration-conventions", "Details.");
    await writePage("db", "We follow [[Alembic]] here.");

    await repairAndApply();

    const rendered = (await readPage("db")).replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2");
    expect(rendered).toContain("We follow Alembic here.");
  });

  it("preserves an existing alias while repointing it", async () => {
    await writePage("tool-registry-integration-surface", "Details.");
    await writePage("agents", "See [[Tool Registry|the registry]].");

    await repairAndApply();

    expect(await readPage("agents")).toContain(
      "[[tool-registry-integration-surface|the registry]]",
    );
  });

  it("leaves a slug that prefixes two pages untouched", async () => {
    await writePage("docker-compose-setup", "Details.");
    await writePage("docker-image-build", "Details.");
    await writePage("ops", "We use [[Docker]] daily.");

    await repairAndApply();

    expect(await readPage("ops")).toContain("[[Docker]]");
  });

  it("leaves a link with no candidate page untouched", async () => {
    await writePage("deployment", "Runs behind [[Caddy]].");

    await repairAndApply();

    expect(await readPage("deployment")).toContain("[[Caddy]]");
  });

  it("does not touch a link that already resolves", async () => {
    await writePage("workspace", "Details.");
    await writePage("onboarding", "Create a [[Workspace]] first.");

    await repairAndApply();

    expect(await readPage("onboarding")).toContain("[[Workspace]]");
  });

  it("refuses a slug too short to prefix meaningfully", async () => {
    await writePage("ai-governance-policy", "Details.");
    await writePage("intro", "About [[AI]] generally.");

    await repairAndApply();

    expect(await readPage("intro")).toContain("[[AI]]");
  });

  it("writes nothing on a second run", async () => {
    await writePage("argo-cd-image-update-ownership-model", "Details.");
    await writePage("deployment", "Managed by [[Argo CD]].");

    await repairAndApply();
    const writes = await repairLinks(tmpDir);

    expect(writes).toEqual([]);
  });

  it("repairs every occurrence across pages in one pass", async () => {
    await writePage("external-secrets-operator-runtime-wiring", "Details.");
    await writePage("eks", "Uses [[External Secrets Operator]] twice: [[External Secrets Operator]].");
    await writePage("k3s", "Also [[External Secrets Operator]].");

    await repairAndApply();

    const eks = await readPage("eks");
    const k3s = await readPage("k3s");
    expect(eks.match(/external-secrets-operator-runtime-wiring/g)).toHaveLength(2);
    expect(k3s).toContain("[[external-secrets-operator-runtime-wiring|External Secrets Operator]]");
  });

  it("leaves frontmatter untouched", async () => {
    await writePage("argo-cd-image-update-ownership-model", "Details.");
    await writePage("deployment", "Managed by [[Argo CD]].");
    const before = (await readPage("deployment")).split("---")[1];

    await repairAndApply();

    expect((await readPage("deployment")).split("---")[1]).toBe(before);
  });
});
