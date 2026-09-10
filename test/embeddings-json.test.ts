/**
 * Bounded JSON serialization keeps existing small-store bytes while refusing
 * oversized candidates before one giant vector string is constructed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeEmbeddingJson } from "../src/utils/embeddings-json.js";
import { binaryFixture } from "./fixtures/binary-embedding-store.js";

afterEach(() => vi.restoreAllMocks());

describe("bounded embedding JSON", () => {
  it("preserves pretty JSON exactly at the UTF-8 byte limit", () => {
    const store = binaryFixture();
    const expected = JSON.stringify(store, null, 2);
    const size = Buffer.byteLength(expected);
    expect(serializeEmbeddingJson(store, size)).toBe(expected);
    expect(serializeEmbeddingJson(store, size - 1)).toBeNull();
  });

  it("preserves empty and absent record arrays and property order", () => {
    const { chunks: _chunks, ...store } = binaryFixture();
    const { entries, ...rest } = store;
    const reordered = { entries, ...rest, model: "escaped\n\"研究\"" };
    expect(serializeEmbeddingJson(reordered)).toBe(JSON.stringify(reordered, null, 2));
    expect(serializeEmbeddingJson({ ...store, entries: [] })).toBe(JSON.stringify({ ...store, entries: [] }, null, 2));
  });

  it("signals binary fallback for a JSON RangeError", () => {
    vi.spyOn(JSON, "stringify").mockImplementationOnce(() => { throw new RangeError("Invalid string length"); });
    expect(serializeEmbeddingJson(binaryFixture())).toBeNull();
  });

  it("does not misclassify other serialization failures as a size limit", () => {
    vi.spyOn(JSON, "stringify").mockImplementationOnce(() => { throw new TypeError("bad value"); });
    expect(() => serializeEmbeddingJson(binaryFixture())).toThrow("bad value");
  });

  it("stops inspecting records after the byte budget is exhausted", () => {
    const store = binaryFixture();
    Object.defineProperty(store.entries[1], "title", { get: () => { throw new Error("read beyond budget"); } });
    expect(serializeEmbeddingJson(store, 1)).toBeNull();
  });
});
