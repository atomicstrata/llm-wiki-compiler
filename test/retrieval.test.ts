/**
 * Tests for chunk splitting, content hashing, and BM25 reranking.
 *
 * These helpers are pure CPU-side utilities — no provider or filesystem mocks
 * required. We focus on the invariants that downstream code depends on:
 *   - chunk size respects the configured target/maximum bounds
 *   - identical text produces identical hashes (enabling incremental skipping)
 *   - BM25 reranking surfaces keyword-matching chunks above noise
 */

import { describe, it, expect } from "bun:test";
import {
  splitIntoChunks,
  hashChunkText,
  rerankWithBm25,
} from "../src/utils/retrieval.js";
import {
  CHUNK_MAX_CHARS,
  CHUNK_MIN_CHARS,
  CHUNK_TARGET_CHARS,
} from "../src/utils/constants.js";

function makeParagraph(seed: string, length: number): string {
  let out = seed;
  while (out.length < length) out += ` ${seed}`;
  return out.slice(0, length);
}

describe("splitIntoChunks", () => {
  it("returns an empty array for empty input", () => {
    expect(splitIntoChunks("")).toEqual([]);
    expect(splitIntoChunks("\n\n   \n\n")).toEqual([]);
  });

  it("keeps a short body as a single chunk", () => {
    const body = "First paragraph.\n\nSecond paragraph.";
    const chunks = splitIntoChunks(body);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("First paragraph");
    expect(chunks[0]).toContain("Second paragraph");
  });

  it("splits when paragraphs collectively exceed the chunk target size", () => {
    const para = makeParagraph("alpha", CHUNK_TARGET_CHARS - 50);
    const body = `${para}\n\n${para}\n\n${para}`;
    const chunks = splitIntoChunks(body);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    }
  });

  it("hard-cuts paragraphs longer than CHUNK_MAX_CHARS", () => {
    const giant = "x".repeat(CHUNK_MAX_CHARS * 2 + 50);
    const chunks = splitIntoChunks(giant);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    }
  });

  it("merges a tiny trailing fragment into the previous chunk", () => {
    const big = makeParagraph("beta", CHUNK_TARGET_CHARS - 20);
    const tiny = "small tail";
    const chunks = splitIntoChunks(`${big}\n\n${tiny}`);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("small tail");
    expect(chunks[chunks.length - 1].length).toBeGreaterThanOrEqual(CHUNK_MIN_CHARS);
  });
});

describe("hashChunkText", () => {
  it("is deterministic for identical input", () => {
    expect(hashChunkText("hello world")).toBe(hashChunkText("hello world"));
  });

  it("differs across distinct inputs", () => {
    expect(hashChunkText("alpha")).not.toBe(hashChunkText("beta"));
  });

  it("treats whitespace as significant", () => {
    expect(hashChunkText("hello world")).not.toBe(hashChunkText("hello  world"));
  });
});

describe("rerankWithBm25", () => {
  it("returns an empty array when given no candidates", () => {
    expect(rerankWithBm25("anything", [])).toEqual([]);
  });

  it("ranks documents containing query terms above noise", () => {
    const candidates = [
      { text: "apples and oranges grow on trees", baseScore: 0.1 },
      { text: "the quick brown fox jumps over the lazy dog", baseScore: 0.5 },
      { text: "embedding stores hold dense vectors for retrieval", baseScore: 0.4 },
    ];
    const ranked = rerankWithBm25("embedding retrieval", candidates);
    expect(ranked[0].candidate.text).toContain("embedding");
  });

  it("preserves base-score ordering when query terms match nothing", () => {
    const candidates = [
      { text: "cat sat on mat", baseScore: 0.9 },
      { text: "dog ran in park", baseScore: 0.1 },
    ];
    const ranked = rerankWithBm25("xylophone", candidates);
    expect(ranked[0].candidate.baseScore).toBe(0.9);
  });

  it("uses base score when query is empty", () => {
    const candidates = [
      { text: "alpha", baseScore: 0.2 },
      { text: "beta", baseScore: 0.8 },
    ];
    const ranked = rerankWithBm25("", candidates);
    expect(ranked.map((r) => r.candidate.baseScore)).toEqual([0.2, 0.8]);
  });

  it("breaks ties using the original semantic score", () => {
    const candidates = [
      { text: "shared keyword chunk one", baseScore: 0.1 },
      { text: "shared keyword chunk two", baseScore: 0.9 },
    ];
    const ranked = rerankWithBm25("shared keyword", candidates);
    expect(ranked[0].candidate.baseScore).toBe(0.9);
  });
});
