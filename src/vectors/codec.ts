/**
 * @file src/vectors/codec.ts
 * @description Float32 encoding of vectors in the piecewise vector store, and
 * the strict, CLOSED validation of stored rows.
 *
 * A vector is stored as explicit little-endian float32 bytes, base64: every
 * element takes `Math.fround(x)`, the existing binary container's semantics,
 * and an element that is not finite after rounding is refused before it is
 * written. Decoding allocates one `Float32Array` copy and rejects anything
 * that is not canonical base64 of exactly `dimensions` finite values. Rows
 * have exactly their known keys, qualified page ids, and identities that
 * agree with the key they are stored under; anything else is corruption.
 */

import { corrupt, invalidWrite } from "../segments/contracts.js";
import { parseQualifiedPageId } from "../utils/page-id.js";
import { chunkVectorKey, type ChunkVectorRow, type PageMetaRow, type PageVectorRow } from "./contracts.js";

/** Largest vector dimension accepted. */
export const MAX_DIMENSIONS = 65_536;

/** Encode `vector` as base64 little-endian float32, refusing a value that is not finite after rounding. */
export function encodeVector(vector: readonly number[]): string {
  if (vector.length === 0 || vector.length > MAX_DIMENSIONS) invalidWrite("a vector has an unsupported length");
  const bytes = Buffer.alloc(vector.length * 4);
  vector.forEach((value, at) => {
    if (!Number.isFinite(Math.fround(value))) invalidWrite("a vector value is not finite as float32");
    bytes.writeFloatLE(value, at * 4);
  });
  return bytes.toString("base64");
}

/** Decode canonical base64 of exactly `dimensions` finite little-endian float32 values (any length when `dimensions` is 0). */
export function decodeVector(vec: unknown, dimensions: number): Float32Array {
  if (typeof vec !== "string") corrupt("a stored vector is not encoded");
  const bytes = Buffer.from(vec, "base64");
  if (bytes.toString("base64") !== vec) corrupt("a stored vector is not canonical base64");
  if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0 || (dimensions > 0 && bytes.byteLength !== dimensions * 4)) corrupt("a stored vector has the wrong length");
  const floats = new Float32Array(bytes.byteLength / 4);
  for (let at = 0; at < floats.length; at += 1) {
    floats[at] = bytes.readFloatLE(at * 4);
    if (!Number.isFinite(floats[at]!)) corrupt("a stored vector holds a non-finite value");
  }
  return floats;
}

/** Cosine similarity of a query and a stored float32 vector; 0 for a zero-magnitude or mismatched pair. */
export function cosineFloat32(query: readonly number[], stored: Float32Array): number {
  if (query.length !== stored.length || query.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let at = 0; at < query.length; at += 1) {
    dot += query[at]! * stored[at]!;
    magA += query[at]! * query[at]!;
    magB += stored[at]! * stored[at]!;
  }
  return magA === 0 || magB === 0 ? 0 : dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/** Whether `value` is an object with exactly `keys`, all string-valued except those named in `numeric`. */
function closedRow(value: unknown, keys: readonly string[], numeric: readonly string[] = []): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const present = Object.keys(value);
  if (present.length !== keys.length || !keys.every((key) => present.includes(key))) return false;
  return keys.every((key) => (numeric.includes(key) ? Number.isSafeInteger((value as Record<string, unknown>)[key]) : typeof (value as Record<string, unknown>)[key] === "string"));
}

/** Whether `pageId` is a qualified page id. */
function qualified(pageId: unknown): boolean {
  return typeof pageId === "string" && parseQualifiedPageId(pageId as never) !== null;
}

const PAGE_ROW_KEYS = ["pageId", "title", "summary", "embeddingTextHash", "updatedAt", "vec"] as const;
const CHUNK_ROW_KEYS = ["pageId", "title", "chunkIndex", "contentHash", "text", "updatedAt", "vec"] as const;

/** Validate a stored page-embedding row stored under `key`. */
export function asPageVectorRow(value: unknown, key: string): PageVectorRow {
  if (!closedRow(value, PAGE_ROW_KEYS) || !qualified(value.pageId) || key !== `p:${value.pageId as string}`) corrupt(`stored page embedding ${key.slice(0, 80)} is malformed`);
  return value as unknown as PageVectorRow;
}

/** Validate a stored chunk-embedding row stored under `key`. */
export function asChunkVectorRow(value: unknown, key: string): ChunkVectorRow {
  // The key must be EXACTLY the canonical key of the row's identity, so one chunk can never sit under two spellings.
  const valid = closedRow(value, CHUNK_ROW_KEYS, ["chunkIndex"]) && qualified(value.pageId) && (value.chunkIndex as number) >= 0
    && key === chunkVectorKey(value.pageId as string, value.chunkIndex as number);
  if (!valid) corrupt(`stored chunk embedding ${key.slice(0, 80)} is malformed`);
  return value as unknown as ChunkVectorRow;
}

/** Validate a stored page metadata row. */
export function asPageMetaRow(value: unknown): PageMetaRow {
  const row = value as Record<string, unknown> | null;
  const valid = row !== null && typeof row === "object" && !Array.isArray(row) && Object.keys(row).length === 4
    && typeof row.embeddingTextHash === "string" && Array.isArray(row.chunkHashes) && row.chunkHashes.every((hash) => typeof hash === "string")
    && typeof row.model === "string" && (row.fingerprint === null || typeof row.fingerprint === "string");
  if (!valid) corrupt("a stored page embedding metadata row is malformed");
  return row as unknown as PageMetaRow;
}
