/**
 * @file test/query-embedding-degrade.test.ts
 * @description D29 fix (ii): with a v3 store PRESENT, a failing embedding call
 * (the keyless configuration — an agent provider that cannot embed) degrades
 * the page-level leg to the LLM/index fallback — which needs no embedder —
 * with an `embedding-degraded` warning, instead of aborting the whole query.
 */

import { describe, expect, it, vi } from "vitest";
import { useAlphaPageFixture, mockEmbeddingFailure } from "./fixtures/alpha-page.js";
import { generateAnswer } from "../src/commands/query.js";

// Selection call (tools present) picks the seeded concept; answer call echoes
// its grounding prompt — neither needs an embedder, which is the point.
vi.mock("../src/utils/llm.js", () => ({
  callClaude: vi.fn(async (opts: { tools?: unknown[]; messages: Array<{ content: string }> }) =>
    opts.tools ? JSON.stringify({ pages: ["concepts/alpha"], reasoning: "r" }) : opts.messages[0].content),
}));

const seedRootWithPageStore = useAlphaPageFixture("embed-degrade", true);

describe("page-level embedding failure degrades to the fallback", () => {
  it.each([
    { embeddingFailure: "fallback" as const },
    { pageScope: ["concepts/alpha"] },
    { review: true },
  ])("answers via fallback only when opted in: %j", async (options) => {
    const root = await seedRootWithPageStore();
    const embed = mockEmbeddingFailure();

    await expect(generateAnswer(root, "what is alpha?")).rejects.toThrow("no embedding credentials");
    await expect(generateAnswer(root, "what is alpha?", { ...options, embeddingFailure: "throw" }))
      .rejects.toThrow("no embedding credentials");
    const result = await generateAnswer(root, "what is alpha?", options);
    // PRECONDITION pinned: the v3 store was loaded and the embed call was
    // actually reached — the degrade is witnessed, not vacuously absent.
    expect(embed, "the embedding path was never reached").toHaveBeenCalled();
    expect(result.answer).toContain("ALPHA_BODY");
    expect(result.pageIds).toEqual(["concepts/alpha"]);
    expect((result.warnings ?? []).map((w) => w.code)).toContain("embedding-degraded");
  });
});
