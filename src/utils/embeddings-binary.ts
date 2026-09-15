/**
 * Self-contained embedding container codec. The storage version is separate
 * from the logical store version; filesystem selection belongs to persistence.
 */
import type { EmbeddingStore, EmbeddingStoreV3 } from "./embeddings-store.js";
import { MAX_EMBEDDING_ENTRIES } from "./constants.js";
import { assertEmbeddingStoreValid, assertFieldCaps, EmbeddingIntegrityError } from "./embeddings-validate.js";
import { serializeEmbeddingJson } from "./embeddings-json.js";

/** Binary limits include real chunk text, not only vector storage. */
const MAX_BINARY_METADATA_BYTES = 256 * 1024 * 1024;
export const MAX_BINARY_STORE_BYTES = 512 * 1024 * 1024;
const MAGIC = "LLMWEB01";
const HEADER_BYTES = 12;
const FLOAT_BYTES = 4;
type VectorRecord = { vector: number[] };

/** Strip vector payloads without changing the logical record metadata. */
function withoutVector({ vector: _vector, ...metadata }: VectorRecord): Record<string, unknown> {
  return metadata;
}

/** Reject malformed UTF-8 instead of silently substituting replacement text. */
function parseMetadata(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new EmbeddingIntegrityError("malformed binary metadata");
  }
}

/** Validate dimensions/count before allocating any decoded vector arrays. */
function readMetadata(bytes: Buffer): { store: Record<string, unknown>; offset: number } {
  if (bytes.length < HEADER_BYTES || bytes.subarray(0, 8).toString() !== MAGIC) {
    throw new EmbeddingIntegrityError("invalid binary header");
  }
  const length = bytes.readUInt32LE(8);
  if (length > MAX_BINARY_METADATA_BYTES || bytes.length > MAX_BINARY_STORE_BYTES) {
    throw new EmbeddingIntegrityError("binary store exceeds byte limits");
  }
  const offset = HEADER_BYTES + length;
  if (offset > bytes.length) throw new EmbeddingIntegrityError("truncated binary metadata");
  const store = parseMetadata(bytes.subarray(HEADER_BYTES, offset));
  if (!store || typeof store !== "object" || Array.isArray(store)) {
    throw new EmbeddingIntegrityError("binary metadata must be an object");
  }
  return { store: store as Record<string, unknown>, offset };
}

/** Validate record shape and payload accounting without trusting metadata offsets. */
function metadataRecords(store: Record<string, unknown>, payloadBytes: number): Record<string, unknown>[] {
  if (![1, 2, 3].includes(store.version as number) || !Array.isArray(store.entries) ||
      (store.chunks !== undefined && !Array.isArray(store.chunks))) {
    throw new EmbeddingIntegrityError("invalid binary store shape");
  }
  const records: unknown[] = [...store.entries, ...((store.chunks as unknown[] | undefined) ?? [])];
  assertPayloadSize(store.dimensions as number, records.length, payloadBytes);
  if (records.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new EmbeddingIntegrityError("binary metadata record must be an object");
  }
  return records as Record<string, unknown>[];
}

/** Check resource accounting before constructing any decoded vector arrays. */
function assertPayloadSize(dimensions: number, count: number, payloadBytes: number): void {
  const expected = count * dimensions * FLOAT_BYTES;
  if (!Number.isSafeInteger(dimensions) || dimensions < 0 || count > MAX_EMBEDDING_ENTRIES ||
      (count > 0 && dimensions === 0) || !Number.isSafeInteger(expected) || expected !== payloadBytes) {
    throw new EmbeddingIntegrityError("binary payload length does not match dimensions/count");
  }
}

/** Encode metadata and vectors into one container. */
export function encodeBinaryStore(store: EmbeddingStore | EmbeddingStoreV3): Buffer {
  assertEmbeddingStoreValid(store);
  assertFieldCaps(store as unknown as Record<string, unknown>);
  const records = [...store.entries, ...(store.chunks ?? [])];
  const metadata = { ...store, entries: store.entries.map(withoutVector),
    ...(store.chunks === undefined ? {} : { chunks: store.chunks.map(withoutVector) }) };
  const text = serializeEmbeddingJson(metadata, MAX_BINARY_METADATA_BYTES);
  if (text === null) throw new RangeError("binary metadata exceeds 256 MiB; prune entries");
  const metadataBytes = Buffer.byteLength(text);
  const size = HEADER_BYTES + metadataBytes + records.length * store.dimensions * FLOAT_BYTES;
  if (!Number.isSafeInteger(size) || size > MAX_BINARY_STORE_BYTES) {
    throw new RangeError("binary store exceeds 512 MiB; prune entries or use a lower-dimension model");
  }
  const bytes = Buffer.alloc(size);
  bytes.write(MAGIC);
  bytes.writeUInt32LE(metadataBytes, 8);
  bytes.write(text, HEADER_BYTES, metadataBytes, "utf8");
  writeVectors(bytes, HEADER_BYTES + metadataBytes, records);
  return bytes;
}

/** Explicit endian writes also support arbitrary metadata-byte alignment. */
function writeVectors(bytes: Buffer, offset: number, records: VectorRecord[]): void {
  for (const record of records) {
    for (const value of record.vector) {
      if (!Number.isFinite(Math.fround(value))) throw new EmbeddingIntegrityError("vector overflows finite Float32");
      bytes.writeFloatLE(value, offset);
      offset += FLOAT_BYTES;
    }
  }
}

/** Decode a container without consulting any other index file. */
export function decodeBinaryStore(bytes: Buffer): Record<string, unknown> {
  const { store, offset: start } = readMetadata(bytes);
  const records = metadataRecords(store, bytes.length - start);
  let offset = start;
  for (const record of records) {
    const vector = new Array<number>(store.dimensions as number);
    for (let i = 0; i < vector.length; i++) {
      vector[i] = bytes.readFloatLE(offset);
      offset += FLOAT_BYTES;
    }
    record.vector = vector;
  }
  assertEmbeddingStoreValid(store);
  return store;
}
