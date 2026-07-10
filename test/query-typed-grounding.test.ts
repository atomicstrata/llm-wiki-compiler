/**
 * @file test/query-typed-grounding.test.ts
 * @description Acceptance tests for F1 — the query/answer path carries the
 * qualified `pageId` end-to-end so a typed semantic hit grounds the answer on
 * the RIGHT page (loading `wiki/<typed>/foo.md`, not `wiki/concepts/foo.md`).
 *
 * The chunk source for the query path is the v3 pipeline; each chunk hit carries
 * its `pageId`. These tests hand-build a v3 store on disk (with chunks for a
 * typed `papers/foo` and a colliding concept `foo`), stub the provider's query
 * embedding so a chosen page ranks first, and stub `callClaude` to ECHO the
 * grounding context so the test can assert which page's body reached the answer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildCollidingProject, chunkOf, echoCallClaudeModule, mockQueryVector, seedTypedProject, writeChunkStore, PAPERS_BODY, CONCEPT_BODY } from "./fixtures/typed-grounding.js";

// Echo the grounding context (the user message) so we can assert which page
// body/metadata reached the answer prompt.
vi.mock("../src/utils/llm.js", () => echoCallClaudeModule());

/** Build the temp project: index.md, a concept `foo` + typed `papers/foo`, a v3 store. */
async function buildProject(papersVec: number[], conceptVec: number[]): Promise<string> {
  return buildCollidingProject("qtyped", papersVec, conceptVec);
}

describe("query typed grounding — F1 pageId end-to-end", () => {
  let generateAnswer: typeof import("../src/commands/query.js").generateAnswer;

  beforeEach(async () => {
    ({ generateAnswer } = await import("../src/commands/query.js"));
  });
  afterEach(() => vi.restoreAllMocks());

  it("a papers/foo semantic hit grounds on papers/foo's body (the typed dir), kept distinct from concepts/foo", async () => {
    mockQueryVector([1, 0]); // ranks the chunk whose vector aligns with [1,0] first
    const root = await buildProject([1, 0], [0, 1]);
    const result = await generateAnswer(root, "scaling?");

    // The typed body loaded from wiki/papers/foo.md (NOT collapsed to a bare
    // `foo` slug that would read wiki/concepts/foo.md) and ranks first.
    expect(result.answer).toContain(PAPERS_BODY);
    expect(result.pageIds[0]).toBe("papers/foo");
    // The two same-slug pages stay DISTINCT qualified ids (no slug collapse).
    expect(new Set(result.pageIds)).toEqual(new Set(["papers/foo", "concepts/foo"]));
  });

  it("a concepts/foo semantic hit ranks the concept first (distinct from papers/foo)", async () => {
    mockQueryVector([0, 1]);
    const root = await buildProject([1, 0], [0, 1]);
    const result = await generateAnswer(root, "general idea?");

    expect(result.answer).toContain(CONCEPT_BODY);
    expect(result.pageIds[0]).toBe("concepts/foo");
    expect(result.pageIds).toContain("papers/foo");
  });

  it("a typed hit with NO colliding concept loads the typed page (not dropped)", async () => {
    mockQueryVector([1, 0]);
    const root = await seedTypedProject("qtyped-solo", "bar", PAPERS_BODY);
    await writeChunkStore(root, [chunkOf("papers/bar", PAPERS_BODY, [1, 0])]);

    const result = await generateAnswer(root, "anything");
    expect(result.answer).toContain(PAPERS_BODY);
    expect(result.pageIds).toContain("papers/bar");
  });

  it("QueryResult carries qualified ids AND a derived display slug; pages still works", async () => {
    mockQueryVector([1, 0]);
    const root = await buildProject([1, 0], [0, 1]);
    const result = await generateAnswer(root, "scaling?");

    expect(result.pageIds).toContain("papers/foo");
    expect(result.refs.some((r) => r.pageId === "papers/foo")).toBe(true);
    // Legacy display slug preserved (derived via slugFromPageId).
    expect(result.selectedPages).toContain("foo");
  });

  // Finding 5: the grounding prompt heads each page with its QUALIFIED pageId
  // plus title/summary, so same-slug pages stay distinguishable to the answer LLM.
  it("grounds the answer prompt with both qualified pageId headers + title + summary", async () => {
    mockQueryVector([1, 0]);
    const root = await buildProject([1, 0], [0, 1]);
    const prompt = (await generateAnswer(root, "scaling?")).answer; // callClaude echoes the prompt

    expect(prompt).toContain("--- Page: papers/foo ---");
    expect(prompt).toContain("--- Page: concepts/foo ---");
    expect(prompt).toContain("# Concept Foo");
    expect(prompt).toContain("> cs"); // concepts/foo summary
    expect(prompt).toContain(PAPERS_BODY);
    expect(prompt).toContain(CONCEPT_BODY);
  });
});
