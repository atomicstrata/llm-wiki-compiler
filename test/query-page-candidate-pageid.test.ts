/**
 * @file test/query-page-candidate-pageid.test.ts
 * @description PR4 Finding-2 acceptance — the PAGE-level LLM candidate selection
 * (`selectFromCandidates`, reached when chunk retrieval is empty but page-level
 * embeddings exist) is keyed by the QUALIFIED `pageId`, not a bare slug. Two
 * same-slug pages (`concepts/foo` + `papers/foo`) must render as DISTINCT
 * candidate keys, the LLM's qualified pick must resolve to the right namespace,
 * and an unknown token must be DROPPED (never fabricated into `concepts/<token>`).
 *
 * The `callClaude` mock returns the selection tool-call JSON when `tools` are
 * passed (the page-selection call) and otherwise ECHOES the grounding context
 * (the answer call), so a test can assert both the selected pageId and which
 * page body reached the answer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import { writePage } from "./fixtures/write-page.js";
import { mockQueryVector, pageEntryOf, seedTypedProject, writePageStore } from "./fixtures/typed-grounding.js";

const PAPERS_BODY = "PAPERS_FOO_DISTINCTIVE_BODY about transformer scaling.";
const CONCEPT_BODY = "CONCEPT_FOO_DISTINCTIVE_BODY about a general idea.";

let selectTokens: string[] = [];
let lastIndex = "";

vi.mock("../src/utils/llm.js", () => ({
  callClaude: vi.fn(async (opts: { tools?: unknown[]; messages: Array<{ content: string }> }) => {
    if (opts.tools) {
      lastIndex = opts.messages[0].content;
      return JSON.stringify({ pages: selectTokens, reasoning: "test" });
    }
    return opts.messages[0].content;
  }),
}));

/** Seed index.md, a concept `foo` + typed `papers/foo`, and a PAGE-only v3 store (no chunks). */
async function buildProject(): Promise<string> {
  const root = await seedTypedProject("qpage", "foo", PAPERS_BODY);
  await writePage(path.join(root, "wiki/concepts"), "foo", { title: "Concept Foo", summary: "cs" }, CONCEPT_BODY);
  await writePageStore(root, [
    pageEntryOf("papers/foo", "foo", "s", [1, 0]),
    pageEntryOf("concepts/foo", "Concept Foo", "cs", [1, 0]),
  ]);
  mockQueryVector([1, 0]);
  return root;
}

describe("query page-level candidate selection — keyed by pageId (Finding 2)", () => {
  let generateAnswer: typeof import("../src/commands/query.js").generateAnswer;

  beforeEach(async () => {
    selectTokens = [];
    lastIndex = "";
    ({ generateAnswer } = await import("../src/commands/query.js"));
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders both same-slug pages as DISTINCT qualified keys (not two **foo**)", async () => {
    const root = await buildProject();
    selectTokens = ["papers/foo"];
    await generateAnswer(root, "scaling?");
    expect(lastIndex).toContain("**papers/foo**");
    expect(lastIndex).toContain("**concepts/foo**");
    expect(lastIndex).not.toContain("**foo**");
  });

  it("a returned papers/foo resolves to pageId papers/foo and grounds the papers body", async () => {
    const root = await buildProject();
    selectTokens = ["papers/foo"];
    const result = await generateAnswer(root, "scaling?");
    expect(result.pageIds).toContain("papers/foo");
    expect(result.pageIds).not.toContain("concepts/foo");
    expect(result.answer).toContain(PAPERS_BODY);
  });

  it("a namespaced queries/bar pick resolves to queries/bar, not concepts", async () => {
    const root = await seedTypedProject("qpage-q", "bar", "TYPED");
    await writePage(path.join(root, "wiki/queries"), "bar", { title: "Query Bar", summary: "qs" }, "QUERY_BAR_BODY.");
    await writePageStore(root, [pageEntryOf("queries/bar", "Query Bar", "qs", [1, 0])]);
    mockQueryVector([1, 0]);
    selectTokens = ["queries/bar"];

    const result = await generateAnswer(root, "anything");
    expect(result.pageIds).toEqual(["queries/bar"]);
    expect(result.answer).toContain("QUERY_BAR_BODY");
  });

  it("an unknown returned token is DROPPED (no fabricated concepts ref)", async () => {
    const root = await buildProject();
    selectTokens = ["papers/nope"];
    const result = await generateAnswer(root, "scaling?");
    expect(result.pageIds).toEqual([]);
    expect(result.answer).toBe("");
  });
});
