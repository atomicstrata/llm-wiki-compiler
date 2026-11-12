/**
 * @file test/resolver-literal-parse.test.ts
 * @description Interlink resolution parses a page for literal Markdown only
 * when a title actually occurs in it, and at most once per distinct body.
 *
 * Finding code regions needs a full Markdown parse, and the resolver checks
 * every page against every title. Parsing once per title regardless of matches
 * made a 200-page wiki with no matching titles take seconds instead of
 * milliseconds. Counting parser calls pins the behaviour without timing.
 */

import { describe, it, expect, vi, afterEach } from "bun:test";
import { mocked } from "./mocked.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { managedTempRoots } from "./fixtures/managed-temp-roots.js";

// Copy the real modules first: vi.mock patches them in place, so a later read would see the mock.
const realCompilerLinkRepairCode = { ...(await import("../src/compiler/link-repair-code.js")) };

vi.mock("../src/compiler/link-repair-code.js", () => {
  const real = realCompilerLinkRepairCode;
  return { isLiteralMarkdown: vi.fn(real.isLiteralMarkdown) };
});

const roots = managedTempRoots();
afterEach(roots.cleanup);
const PAGE_COUNT = 20;

/** A project of pages titled `Topic N` whose bodies mention `mention` (or nothing). */
async function project(mention: string): Promise<{ root: string; slugs: string[] }> {
  const root = await roots.create("resolver-parse");
  const slugs = Array.from({ length: PAGE_COUNT }, (_, i) => `topic-${i}`);
  await Promise.all(slugs.map((slug, i) => writeFile(path.join(root, "wiki/concepts", `${slug}.md`),
    `---\ntitle: Topic ${i}\nsummary: s\nsources: []\n---\n\nPlain prose with \`code\`. ${mention}\n`)));
  return { root, slugs };
}

describe("interlink resolution parses only when a title occurs", () => {
  it("never parses when no page mentions another page's title", async () => {
    const { resolveAndApplyLinks } = await import("../src/compiler/resolver.js");
    const { isLiteralMarkdown } = await import("../src/compiler/link-repair-code.js");
    mocked(isLiteralMarkdown).mockClear();
    const { root, slugs } = await project("");
    await resolveAndApplyLinks(root, slugs, []);
    expect(isLiteralMarkdown).not.toHaveBeenCalled();
  });

  it("parses each page at most once per distinct body when a title occurs only in code", async () => {
    const { resolveAndApplyLinks } = await import("../src/compiler/resolver.js");
    const { isLiteralMarkdown } = await import("../src/compiler/link-repair-code.js");
    mocked(isLiteralMarkdown).mockClear();
    const { root, slugs } = await project("`Topic 0` `Topic 1`");
    await resolveAndApplyLinks(root, slugs, []);
    // Every page mentions two titles, both inside code, so no page body changes:
    // one parse per page, not one per matching title.
    expect(mocked(isLiteralMarkdown).mock.calls.length).toBeLessThanOrEqual(PAGE_COUNT);
  });
});
