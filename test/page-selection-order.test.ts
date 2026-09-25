/**
 * Unit tests for the page-selection prompt's ordering: the wiki index first,
 * the question last.
 *
 * Without embeddings, every query on a wiki selects pages over the same index,
 * so the index must form a prefix that two different questions share. The
 * question must still be sent, after the index, and the parsed result must be
 * unchanged by the ordering.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/utils/llm.js", () => ({ callClaude: vi.fn() }));

const INDEX = "- concepts/alpha: Alpha summary\n- concepts/beta: Beta summary";

/** User message of the n-th recorded selection call. */
async function userMessageOf(call: number): Promise<string> {
  const { callClaude } = await import("../src/utils/llm.js");
  const request = vi.mocked(callClaude).mock.calls[call][0] as { messages: Array<{ content: string }> };
  return request.messages[0].content;
}

describe("selectPages prompt ordering", () => {
  beforeEach(async () => {
    const { callClaude } = await import("../src/utils/llm.js");
    vi.mocked(callClaude).mockReset();
    vi.mocked(callClaude).mockResolvedValue(JSON.stringify({ pages: ["concepts/alpha"], reasoning: "r" }));
  });

  it("gives two different questions over the same index an identical prefix through the index", async () => {
    const { selectPages } = await import("../src/commands/page-selection.js");
    await selectPages("What is alpha?", INDEX);
    await selectPages("How does beta work?", INDEX);
    const [first, second] = [await userMessageOf(0), await userMessageOf(1)];
    const indexEnd = first.indexOf(INDEX) + INDEX.length;
    expect(first.slice(0, indexEnd)).toBe(second.slice(0, indexEnd));
    expect(first.slice(indexEnd)).toContain("Question: What is alpha?");
    expect(second.slice(indexEnd)).toContain("Question: How does beta work?");
  });

  it("still returns the parsed selection", async () => {
    const { selectPages } = await import("../src/commands/page-selection.js");
    expect(await selectPages("What is alpha?", INDEX)).toEqual({ pages: ["concepts/alpha"], reasoning: "r" });
  });
});
