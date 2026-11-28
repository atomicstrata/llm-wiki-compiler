/**
 * @file test/catalog/typed-cli.test.ts
 * @description `llmwiki catalog pages` on a custom-profile `local-indexed`
 * project (the command body imported directly, run from the project): the JSON envelope
 * carries the typed profile block, `--profile-cursor` and `--problem-cursor`
 * continue its two windows, `--include-body` adds bodies, the human listing
 * prints the entity pages, problems and both continuations, and a foreign
 * cursor is a refusal envelope (exit 2).
 */

import { describe, expect, it, vi } from "bun:test";
import { catalogPagesCommand, type CatalogCommandOptions } from "../../src/commands/catalog.js";
import type { ListPagesProfileBlock } from "../../src/pages/list.js";
import { jsonCommand, setIndexedScale } from "./cli-helpers.js";
import * as output from "../../src/utils/output.js";
import { SAMPLE_PROFILE, writeMarkdownPage, writeProfileFile } from "../fixtures/profile-fixtures.js";
import { useTemporaryCwd } from "../fixtures/temporary-cwd.js";

useTemporaryCwd("llmwiki-typed-cli-", async (root) => {
  await writeProfileFile(root, SAMPLE_PROFILE);
  for (const [slug, text] of [["alpha", "---\ntitle: Alpha\n---\nA body."], ["beta", "---\ntitle: Beta\n---\nB."], ["no-title", "---\nslug: no-title\n---\nX."], ["zz-mismatch", "---\ntitle: M\nslug: other\n---\nY."]] as const) {
    await writeMarkdownPage(root, "wiki/notes", slug, text);
  }
  await setIndexedScale(root);
});

/** Run `catalog pages --json` with `options`; the exit code and the envelope. */
function pagesJson(options: CatalogCommandOptions): Promise<{ code: number; envelope: { profile?: ListPagesProfileBlock; refusal?: { code: string } } }> {
  return jsonCommand(() => catalogPagesCommand({ ...options, json: true }));
}

describe("catalog pages on a typed catalog", () => {
  it("continues both windows through --profile-cursor and --problem-cursor, and adds bodies with --include-body", async () => {
    const first = (await pagesJson({ limit: "1" })).envelope.profile!;
    expect([first.entityPages.map((page) => page.slug), first.entityPages[0]!.body]).toEqual([["alpha"], undefined]);
    const next = (await pagesJson({ limit: "1", profileCursor: first.cursor, includeBody: true })).envelope.profile!;
    expect([next.entityPages.map((page) => page.slug), next.entityPages[0]!.body]).toEqual([["beta"], "B."]);
    const problems = (await pagesJson({ limit: "1", problemCursor: first.problemCursor })).envelope.profile!;
    expect([first.problems!.length, problems.problems!.length, first.problemTotal]).toEqual([1, 1, 2]);
  });

  it("prints the entity pages, problems and both continuations, and refuses a foreign cursor with exit 2", async () => {
    const lines: string[] = [];
    vi.spyOn(output, "status").mockImplementation((_symbol: string, line: string) => { lines.push(line); });
    expect(await catalogPagesCommand({ limit: "1" })).toBe(0);
    expect(lines).toEqual(expect.arrayContaining(["Entity pages: 1 of 3", "notes/alpha: Alpha", "Problems: 1 of 2"]));
    expect(lines.some((line) => line.startsWith("Next entity pages: --profile-cursor t1."))).toBe(true);
    expect(lines.some((line) => line.startsWith("Next problems: --problem-cursor t1."))).toBe(true);
    const refused = await pagesJson({ profileCursor: "7" });
    expect([refused.code, refused.envelope.refusal?.code]).toEqual([2, "catalog_cursor_stale"]);
  });
});
