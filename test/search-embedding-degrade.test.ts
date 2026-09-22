/**
 * @file test/search-embedding-degrade.test.ts
 * @description The `search` sibling of the query embedding-degrade fix: with a
 * v3 store PRESENT, a failing embedding call (the keyless configuration — an
 * agent provider that cannot embed) degrades `pickSearchRefs` to the LLM/index
 * fallback — which needs no embedder — with an `embedding-degraded` warning,
 * instead of aborting the whole search.
 */

import { describe, expect, it, vi } from "vitest";
import { useAlphaPageFixture, mockEmbeddingFailure } from "./fixtures/alpha-page.js";
import { pickSearchRefs } from "../src/search/retrieval.js";

// The fallback's page-selection call (tools present) picks the seeded concept;
// it needs no embedder, which is the point.
vi.mock("../src/utils/llm.js", () => ({
  callClaude: vi.fn(async () => JSON.stringify({ pages: ["concepts/alpha"], reasoning: "r" })),
}));

const seedRootWithPageStore = useAlphaPageFixture("search-embed-degrade", true);

describe("search embedding failure degrades to the fallback", () => {
  it("returns fallback refs and carries the embedding-degraded warning", async () => {
    const root = await seedRootWithPageStore();
    const embed = mockEmbeddingFailure();

    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(pickSearchRefs(root, "what is alpha?")).rejects.toThrow("no embedding credentials");
    const { refs, warnings } = await pickSearchRefs(root, "what is alpha?", { embeddingFailure: "fallback" });
    // PRECONDITION pinned: the v3 store was loaded and the embed call was
    // actually reached — the degrade is witnessed, not vacuously absent.
    expect(embed, "the embedding path was never reached").toHaveBeenCalled();
    expect(refs.map((ref) => ref.pageId)).toEqual(["concepts/alpha"]);
    expect(warnings.map((w) => w.code)).toContain("embedding-degraded");
    expect(stdout).not.toHaveBeenCalled();
  });
});
