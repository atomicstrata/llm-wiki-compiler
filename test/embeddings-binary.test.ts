/**
 * Binary container contract: metadata stays separate from vectors, values use
 * explicit little-endian Float32, and malformed lengths never expose records.
 */
import { describe, expect, it } from "vitest";
import { encodeBinaryStore, decodeBinaryStore } from "../src/utils/embeddings-binary.js";
import { binaryFixture } from "./fixtures/binary-embedding-store.js";
import { EmbeddingIntegrityError } from "../src/utils/embeddings-validate.js";

/** Build altered metadata independently of the codec while retaining the payload. */
function withMetadata(bytes: Buffer, value: unknown): Buffer {
  const metadata = Buffer.from(JSON.stringify(value));
  const header = Buffer.from(bytes.subarray(0, 12));
  header.writeUInt32LE(metadata.length, 8);
  return Buffer.concat([header, metadata, bytes.subarray(12 + bytes.readUInt32LE(8))]);
}

describe("binary embedding container", () => {
  it("round-trips metadata and ordered vectors without vector JSON", () => {
    const original = binaryFixture();
    const bytes = encodeBinaryStore(original);
    expect(bytes.subarray(0, 8).toString()).toBe("LLMWEB01");
    const length = bytes.readUInt32LE(8);
    const metadata = JSON.parse(bytes.subarray(12, 12 + length).toString());
    expect(metadata.entries[0]).not.toHaveProperty("vector");
    expect(bytes.length).toBe(12 + length + 24);
    expect(bytes.readFloatLE(12 + length)).toBeCloseTo(0.1, 7);
    expect(decodeBinaryStore(bytes)).toEqual({ ...original,
      entries: original.entries.map((entry) => ({ ...entry, vector: entry.vector.map(Math.fround) })),
    });
  });

  it("decodes unaligned payload offsets", () => {
    const store = binaryFixture();
    let bytes = encodeBinaryStore(store);
    while (bytes.readUInt32LE(8) % 4 === 0) {
      store.model += "x";
      bytes = encodeBinaryStore(store);
    }
    expect(decodeBinaryStore(bytes).model).toBe(store.model);
  });

  it("retains empty zero-dimensional stores", () => {
    const empty = { ...binaryFixture(), dimensions: 0, entries: [], chunks: [] };
    expect(decodeBinaryStore(encodeBinaryStore(empty))).toEqual(empty);
  });

  it.each([1, 2] as const)("retains logical legacy version %s for existing migration", (version) => {
    const legacy = { version, model: "old", dimensions: 2,
      entries: [{ slug: "alpha", title: "A", summary: "a", vector: [1, 0], updatedAt: "today" }] };
    expect(decodeBinaryStore(encodeBinaryStore(legacy))).toEqual(legacy);
  });

  it.each(["truncated", "extra", "magic", "length", "nan"])("refuses %s payload", (kind) => {
    let bytes = encodeBinaryStore(binaryFixture());
    if (kind === "truncated") bytes = bytes.subarray(0, bytes.length - 1);
    if (kind === "extra") bytes = Buffer.concat([bytes, Buffer.from([0])]);
    if (kind === "magic") bytes[0] = 0;
    if (kind === "length") bytes.writeUInt32LE(0xffffffff, 8);
    if (kind === "nan") bytes.writeFloatLE(NaN, 12 + bytes.readUInt32LE(8));
    expect(() => decodeBinaryStore(bytes)).toThrow();
  });

  it("rejects finite doubles that overflow Float32", () => {
    const store = binaryFixture();
    store.entries[0].vector[0] = Number.MAX_VALUE;
    expect(() => encodeBinaryStore(store)).toThrow(/finite|Float32/);
  });

  it.each(["utf8", "json"])("classifies malformed %s metadata as integrity failure", (kind) => {
    const bytes = encodeBinaryStore(binaryFixture());
    if (kind === "json") bytes[12] = 0x78;
    else {
      const position = bytes.indexOf(Buffer.from("研究"));
      expect(position).toBeGreaterThan(12);
      bytes[position + 1] = 0xff;
    }
    expect(() => decodeBinaryStore(bytes)).toThrow(EmbeddingIntegrityError);
  });

  it.each(["short", "array", "null", "record", "dimensions", "count", "infinity"])("refuses malformed %s structure", (kind) => {
    let bytes = encodeBinaryStore(binaryFixture());
    const metadata = JSON.parse(bytes.subarray(12, 12 + bytes.readUInt32LE(8)).toString());
    if (kind === "short") bytes = bytes.subarray(0, 5);
    if (kind === "array") bytes = withMetadata(bytes, []);
    if (kind === "null") bytes = withMetadata(bytes, null);
    if (kind === "record") bytes = withMetadata(bytes, { ...metadata, entries: [1, 2] });
    if (kind === "dimensions") bytes = withMetadata(bytes, { ...metadata, dimensions: "2" });
    if (kind === "count") bytes = withMetadata(bytes, { ...metadata, dimensions: 1 });
    if (kind === "infinity") bytes.writeFloatLE(Infinity, 12 + bytes.readUInt32LE(8));
    expect(() => decodeBinaryStore(bytes)).toThrow(EmbeddingIntegrityError);
  });
});
