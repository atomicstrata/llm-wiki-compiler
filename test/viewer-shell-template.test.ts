/**
 * Unit tests for `src/viewer/shell.ts` — template loading, in-memory
 * caching, and page-index substitution. The HTTP integration of these
 * helpers is exercised by `test/viewer-server.test.ts`; this file owns
 * the JSON-escape contract and the missing-template / cache-hit edges
 * that are awkward to reach through subprocess fetches.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { rm, writeFile } from "fs/promises";
import path from "path";
import {
  loadShellTemplate,
  resetShellTemplateCache,
  substitutePageIndex,
} from "../src/viewer/shell.js";
import type { ViewerPage } from "../src/viewer/types.js";
import { makeOutsideDir } from "./fixtures/outside-dir.js";

const TEMPLATE_SHELL = `<html><body><!--PAGE_INDEX--></body></html>`;

function buildPage(overrides: Partial<ViewerPage> & { slug: string; title: string }): ViewerPage {
  return {
    id: `concepts/${overrides.slug}`,
    slug: overrides.slug,
    pageDirectory: "concepts",
    title: overrides.title,
    filePath: `/tmp/${overrides.slug}.md`,
    frontmatter: {},
    body: "Body text — must NOT appear in the embedded blob.",
    outgoingLinks: [],
    citations: [],
    warnings: [],
    ...overrides,
  };
}

// `makeOutsideDir` returns a fresh tmp directory; we reuse it here so the
// shell-template tests share temp-dir wiring with the symlink-escape tests.
const makeAssetsDir = makeOutsideDir;

beforeEach(() => {
  resetShellTemplateCache();
});

describe("substitutePageIndex", () => {
  it("replaces the marker with an application/json script tag", () => {
    const out = substitutePageIndex(TEMPLATE_SHELL, [buildPage({ slug: "alpha", title: "Alpha" })]);
    expect(out).toContain('<script type="application/json" id="page-index">');
    expect(out).not.toContain("<!--PAGE_INDEX-->");
  });

  it("produces JSON that round-trips through JSON.parse", () => {
    const pages = [
      buildPage({ slug: "alpha", title: "Alpha" }),
      buildPage({ slug: "beta", title: "Beta" }),
    ];
    const out = substitutePageIndex(TEMPLATE_SHELL, pages);
    const match = out.match(
      /<script type="application\/json" id="page-index">([\s\S]*?)<\/script>/,
    );
    expect(match).not.toBeNull();
    // The JSON-safe escape replaces `<` with the `<` sequence, which is
    // a valid JSON escape and round-trips back to `<` via JSON.parse.
    const parsed = JSON.parse((match![1] as string)) as { pages: Array<{ slug: string }> };
    expect(parsed.pages.map((p) => p.slug)).toEqual(["alpha", "beta"]);
  });

  it("escapes < so a title containing </script> cannot break out", () => {
    const out = substitutePageIndex(
      TEMPLATE_SHELL,
      [buildPage({ slug: "evil", title: "</script><script>alert(1)</script>" })],
    );
    expect(out).not.toContain("</script><script>alert(1)</script>");
    // Exactly one literal </script> remains: the closing tag of the embedded
    // application/json block. Anything from the title appears as <-escaped.
    const closingTags = out.match(/<\/script>/g) ?? [];
    expect(closingTags.length).toBe(1);
  });

  it("never embeds page bodies in the rendered blob", () => {
    const out = substitutePageIndex(
      TEMPLATE_SHELL,
      [buildPage({ slug: "x", title: "X" })],
    );
    expect(out).not.toContain("Body text — must NOT appear in the embedded blob.");
  });
});

describe("loadShellTemplate", () => {
  it("returns the file contents when index.html is present", async () => {
    const dir = await makeAssetsDir();
    await writeFile(path.join(dir, "index.html"), TEMPLATE_SHELL);
    const result = await loadShellTemplate(dir);
    expect(result).toBe(TEMPLATE_SHELL);
  });

  it("returns null when index.html is missing on disk", async () => {
    const dir = await makeAssetsDir();
    const result = await loadShellTemplate(dir);
    expect(result).toBeNull();
  });

  it("serves cached bytes after the file is deleted (in-memory cache)", async () => {
    const dir = await makeAssetsDir();
    await writeFile(path.join(dir, "index.html"), TEMPLATE_SHELL);
    const first = await loadShellTemplate(dir);
    await rm(path.join(dir, "index.html"));
    const second = await loadShellTemplate(dir);
    expect(first).toBe(TEMPLATE_SHELL);
    expect(second).toBe(TEMPLATE_SHELL);
  });

  it("caches the missing-template result so the disk is not hammered", async () => {
    const dir = await makeAssetsDir();
    const first = await loadShellTemplate(dir);
    // Create the file AFTER the first miss — the cache should still report null.
    await writeFile(path.join(dir, "index.html"), TEMPLATE_SHELL);
    const second = await loadShellTemplate(dir);
    expect(first).toBeNull();
    expect(second).toBeNull();
  });
});
