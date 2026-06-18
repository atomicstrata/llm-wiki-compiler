import { describe, it, expect, afterEach } from "vitest";
import {
  EmbeddingIntegrityError,
  isIntegrityError,
  isAuthError,
  isRequestTooLarge,
  isTransient,
  resolveEmbedBatchSize,
  classifyEmbeddingError,
  enrichEmbedError,
  shouldRethrowEmbeddingFailure,
} from "../src/utils/embeddings-batch.js";
import {
  assertVectorValid,
  assertEveryVectorValid,
  normalizeEmbeddingData,
} from "../src/utils/embeddings-validate.js";

const withStatus = (status: number, message = "") => Object.assign(new Error(message), { status });

describe("vector validation", () => {
  it("accepts a finite non-empty vector and rejects bad ones", () => {
    expect(() => assertVectorValid([0.1, 0.2])).not.toThrow();
    expect(() => assertVectorValid([])).toThrow(/empty/i);
    expect(() => assertVectorValid([NaN])).toThrow(/finite/i);
    expect(() => assertVectorValid([Infinity])).toThrow(/finite/i);
    expect(() => assertVectorValid([0.1], 2)).toThrow(/dimension/i);
  });

  it("asserts uniform dimension across a batch", () => {
    expect(() => assertEveryVectorValid([[1, 2], [3, 4]])).not.toThrow();
    expect(() => assertEveryVectorValid([[1, 2], [3]])).toThrow(/dimension/i);
  });
});

describe("normalizeEmbeddingData", () => {
  it("reorders response data by index", () => {
    const data = [{ index: 1, embedding: [9, 9] }, { index: 0, embedding: [1, 1] }];
    expect(normalizeEmbeddingData(data, 2)).toEqual([[1, 1], [9, 9]]);
  });
  it("accepts positional order when no index present", () => {
    expect(normalizeEmbeddingData([{ embedding: [1] }, { embedding: [2] }], 2)).toEqual([[1], [2]]);
  });
  it("throws on cardinality mismatch", () => {
    expect(() => normalizeEmbeddingData([{ index: 0, embedding: [1] }], 2)).toThrow(EmbeddingIntegrityError);
  });
  it("throws on a missing slot (sparse hole)", () => {
    // two items but both index 0 -> slot 1 never filled
    expect(() => normalizeEmbeddingData([{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }], 2))
      .toThrow(EmbeddingIntegrityError);
  });
  it("throws on a duplicate index", () => {
    expect(() => normalizeEmbeddingData([{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }], 2))
      .toThrow(/duplicate|missing/i);
  });
  it("throws on a fractional index", () => {
    expect(() => normalizeEmbeddingData([{ index: 0.5, embedding: [1] }, { index: 1, embedding: [2] }], 2))
      .toThrow(EmbeddingIntegrityError);
  });
  it("throws on mixed indexed/unindexed response", () => {
    expect(() => normalizeEmbeddingData([{ index: 0, embedding: [1] }, { embedding: [2] }], 2))
      .toThrow(/mixed/i);
  });
  it("throws on an empty or non-finite embedding", () => {
    expect(() => normalizeEmbeddingData([{ index: 0, embedding: [] }, { index: 1, embedding: [2] }], 2))
      .toThrow(EmbeddingIntegrityError);
    expect(() => normalizeEmbeddingData([{ index: 0, embedding: [NaN] }, { index: 1, embedding: [2] }], 2))
      .toThrow(EmbeddingIntegrityError);
  });
});

describe("resolveEmbedBatchSize", () => {
  const run = (env: string | undefined, provider = "openai") => {
    if (env === undefined) delete process.env.LLMWIKI_EMBED_BATCH_SIZE;
    else process.env.LLMWIKI_EMBED_BATCH_SIZE = env;
    return resolveEmbedBatchSize(provider);
  };
  afterEach(() => { delete process.env.LLMWIKI_EMBED_BATCH_SIZE; });

  it("uses the per-provider default when unset", () => {
    expect(run(undefined, "openai")).toBe(256);
    expect(run(undefined, "ollama")).toBe(64);
    expect(run(undefined, "minimax")).toBe(64); // fallback
  });
  it("honors a valid override", () => { expect(run("32")).toBe(32); });
  it("clamps an over-cap override to the provider cap", () => { expect(run("99999", "openai")).toBe(2048); });
  it("rejects non-positive / non-integer and falls back to default", () => {
    expect(run("0")).toBe(256);
    expect(run("-5")).toBe(256);
    expect(run("abc")).toBe(256);
    expect(run("1.5")).toBe(256);
  });
});

describe("error taxonomy", () => {
  it("classifies each error class", () => {
    expect(isIntegrityError(new EmbeddingIntegrityError("cardinality"))).toBe(true);
    expect(isAuthError(withStatus(401))).toBe(true);
    expect(isAuthError(new Error("VOYAGE_API_KEY is not set"))).toBe(true);
    expect(isRequestTooLarge(withStatus(413))).toBe(true);
    expect(isRequestTooLarge(withStatus(400, "max allowed tokens per request"))).toBe(true);
    expect(isTransient(withStatus(429))).toBe(true);
    expect(isTransient(withStatus(503))).toBe(true);
    expect(isTransient(new Error("fetch failed"))).toBe(true);
    // a plain 400 with no size hint is NOT oversized — treat as caller error
    expect(isRequestTooLarge(withStatus(400, "bad input"))).toBe(false);
  });
});

describe("failure reporting helpers", () => {
  it("classifies each error into a stable label", () => {
    expect(classifyEmbeddingError(new EmbeddingIntegrityError("x"))).toBe("integrity");
    expect(classifyEmbeddingError(Object.assign(new Error(), { status: 401 }))).toBe("auth");
    expect(classifyEmbeddingError(Object.assign(new Error(), { status: 413 }))).toBe("request-too-large");
    expect(classifyEmbeddingError(Object.assign(new Error(), { status: 429 }))).toBe("transient");
    expect(classifyEmbeddingError(new Error("???"))).toBe("unknown");
  });

  it("enriches with pass, class, and the slug at failedIndex", () => {
    const err = Object.assign(new EmbeddingIntegrityError("cardinality"), { failedIndex: 1 });
    const out = enrichEmbedError(err, "page", (i) => ["a", "b", "c"][i]);
    expect(out.message).toMatch(/page embedding failed \[integrity\] at "b"/);
    expect((out as { cause?: unknown }).cause).toBe(err); // preserves the original for classification
  });

  it("strict gate keys off LLMWIKI_EMBED_STRICT", () => {
    delete process.env.LLMWIKI_EMBED_STRICT;
    expect(shouldRethrowEmbeddingFailure()).toBe(false);
    process.env.LLMWIKI_EMBED_STRICT = "1";
    expect(shouldRethrowEmbeddingFailure()).toBe(true);
    delete process.env.LLMWIKI_EMBED_STRICT;
  });
});
