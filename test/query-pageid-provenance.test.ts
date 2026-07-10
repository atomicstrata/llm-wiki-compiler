/**
 * @file test/query-pageid-provenance.test.ts
 * @description PR4 Finding 1 + 2 — the chunk provenance/debug rendering and the
 * human/log output surfaces carry the QUALIFIED `pageId`, so same-slug pages
 * (`concepts/foo` vs `papers/foo`) stay distinguishable in the answer prompt's
 * excerpt headers, the `--debug` snapshot, the CLI `onPageSelection` callback,
 * and the activity-log entry — while `result.selectedPages` stays bare slugs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import { readFile } from "fs/promises";
import { buildCollidingProject, echoCallClaudeModule, mockQueryVector } from "./fixtures/typed-grounding.js";

// Echo the grounding context (the user message) so we can assert the chunk
// provenance section that reached the answer prompt.
vi.mock("../src/utils/llm.js", () => echoCallClaudeModule());

/** Build the temp project: concept `foo` + typed `papers/foo`, both as chunk hits. */
async function buildProject(): Promise<string> {
  const root = await buildCollidingProject("qprov", [1, 0], [0, 1]);
  mockQueryVector([1, 1]); // aligns with both chunks so BOTH are selected
  return root;
}

describe("query pageId provenance/debug/CLI/log — PR4 F1+F2", () => {
  let generateAnswer: typeof import("../src/commands/query.js").generateAnswer;

  beforeEach(async () => {
    ({ generateAnswer } = await import("../src/commands/query.js"));
  });
  afterEach(() => vi.restoreAllMocks());

  it("answer-prompt chunk provenance heads each excerpt by qualified pageId", async () => {
    const root = await buildProject();
    const prompt = (await generateAnswer(root, "scaling?")).answer; // echoed prompt
    expect(prompt).toContain("--- papers/foo (chunk 0) ---");
    expect(prompt).toContain("--- concepts/foo (chunk 0) ---");
    expect(prompt).not.toContain("--- foo (chunk 0) ---");
  });

  it("debug snapshot distinguishes the two same-slug pages by qualified pageId", async () => {
    const root = await buildProject();
    const result = await generateAnswer(root, "scaling?", { debug: true });
    const ids = result.debug!.pages.map((p) => p.pageId);
    expect(new Set(ids)).toEqual(new Set(["papers/foo", "concepts/foo"]));
    expect(new Set(result.debug!.chunks.map((c) => c.pageId))).toEqual(new Set(["papers/foo", "concepts/foo"]));
  });

  it("onPageSelection + activity log carry qualified ids; selectedPages stays bare slugs", async () => {
    const root = await buildProject();
    let seen: string[] = [];
    const result = await generateAnswer(root, "scaling?", { onPageSelection: (pages) => { seen = pages; } });
    expect(new Set(seen)).toEqual(new Set(["papers/foo", "concepts/foo"]));
    const log = await readFile(path.join(root, "log.md"), "utf-8");
    expect(log).toContain("[[papers/foo]]");
    expect(log).toContain("[[concepts/foo]]");
    expect(result.selectedPages).toEqual(["foo", "foo"]);
  });
});
