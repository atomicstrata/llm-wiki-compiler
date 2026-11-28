/**
 * @file src/segments/format.ts
 * @description The byte format of one immutable segment file, and its strict
 * decoders.
 *
 * A segment is `blocks ‖ footer ‖ trailer`:
 * - each BLOCK is UTF-8 JSON lines, one row per line, keys strictly ascending
 *   across the whole segment; a block is about {@link BLOCK_TARGET_BYTES} and
 *   never splits a row, so it exceeds the target only when it holds a single
 *   larger row (at most {@link MAX_BLOCK_BYTES});
 * - the FOOTER is JSON naming every block's first and last key, offset,
 *   length, row count and SHA-256;
 * - the TRAILER is the footer's byte length as 15 zero-padded decimal digits
 *   and a newline (16 bytes).
 *
 * The manifest records the footer's SHA-256, so an open verifies the block
 * index before trusting any offset, and each block is verified before any row
 * in it is parsed. Every hard limit is checked BEFORE the bytes it bounds are
 * allocated or read, so hostile metadata cannot defeat the resident bound.
 * Every malformation is typed corruption; nothing is repaired.
 */

import { createHash } from "node:crypto";
import {
  BLOCK_TARGET_BYTES, corrupt, invalidWrite, MAX_BLOCK_BYTES, MAX_FOOTER_BYTES, MAX_KEY_CHARS, MAX_ROW_BYTES,
  MAX_SEGMENT_BYTES, MAX_SEGMENT_ROWS, type SegmentRow,
} from "./contracts.js";

/** Bytes of the fixed trailer. */
export const TRAILER_BYTES = 16;

/** One block as the footer describes it. */
export interface BlockEntry {
  readonly first: string;
  readonly last: string;
  readonly offset: number;
  readonly length: number;
  readonly rows: number;
  readonly sha256: string;
}

/** The decoded footer. */
export interface SegmentFooter {
  readonly rows: number;
  readonly blocks: readonly BlockEntry[];
}

/** A row admitted for writing: its key and its encoded line, snapshotted once. */
export interface AdmittedRow {
  readonly k: string;
  readonly line: Buffer;
}

/** One encoded segment and the facts the manifest records about it. */
export interface EncodedSegment {
  readonly bytes: Buffer;
  readonly minKey: string;
  readonly maxKey: string;
  readonly rows: number;
  readonly sha256: string;
  readonly indexSha256: string;
}

/** Hex SHA-256 of `bytes`. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Whether `key` is a key this format accepts. */
export function validKey(key: unknown): key is string {
  return typeof key === "string" && key.length > 0 && key.length <= MAX_KEY_CHARS;
}

/**
 * Admit one row for writing: validate it and encode its line NOW, so a caller
 * mutating the object later cannot change what is ordered, capped or written.
 */
export function admitRow(row: SegmentRow): AdmittedRow {
  if (row === null || typeof row !== "object" || !validKey(row.k)) invalidWrite(`a row needs a key of 1..${MAX_KEY_CHARS} characters`);
  const line = Buffer.from(`${JSON.stringify(row.d === 1 ? { k: row.k, d: 1 } : { k: row.k, v: row.v ?? null })}\n`, "utf8");
  if (line.byteLength > MAX_ROW_BYTES) invalidWrite(`row ${row.k.slice(0, 64)} exceeds ${MAX_ROW_BYTES} bytes`);
  return { k: row.k, line };
}

/** Group admitted rows into blocks, returning the block bytes and their index entries. */
function buildBlocks(rows: readonly AdmittedRow[]): { parts: Buffer[]; blocks: BlockEntry[] } {
  const parts: Buffer[] = [];
  const blocks: BlockEntry[] = [];
  let start = 0;
  let offset = 0;
  while (start < rows.length) {
    let end = start + 1;
    let size = rows[start]!.line.byteLength;
    while (end < rows.length && size + rows[end]!.line.byteLength <= BLOCK_TARGET_BYTES) size += rows[end++]!.line.byteLength;
    const block = Buffer.concat(rows.slice(start, end).map((row) => row.line));
    blocks.push({ first: rows[start]!.k, last: rows[end - 1]!.k, offset, length: block.byteLength, rows: end - start, sha256: sha256Hex(block) });
    parts.push(block);
    offset += block.byteLength;
    start = end;
  }
  return { parts, blocks };
}

/** Encode admitted rows (strictly ascending keys) as one segment within every hard limit. */
export function encodeSegment(rows: readonly AdmittedRow[]): EncodedSegment {
  if (rows.length === 0 || rows.length > MAX_SEGMENT_ROWS) invalidWrite(`a segment holds 1..${MAX_SEGMENT_ROWS} rows`);
  rows.forEach((row, at) => { if (at > 0 && !(rows[at - 1]!.k < row.k)) invalidWrite("segment rows must be in strictly ascending key order"); });
  const { parts, blocks } = buildBlocks(rows);
  const footer = Buffer.from(JSON.stringify({ format: "llmwiki-segment", version: 1, rows: rows.length, blocks }), "utf8");
  if (footer.byteLength > MAX_FOOTER_BYTES) invalidWrite("segment block index exceeds its cap");
  const trailer = Buffer.from(`${String(footer.byteLength).padStart(TRAILER_BYTES - 1, "0")}\n`, "ascii");
  const bytes = Buffer.concat([...parts, footer, trailer]);
  if (bytes.byteLength > MAX_SEGMENT_BYTES) invalidWrite("segment exceeds its byte cap");
  return { bytes, minKey: rows[0]!.k, maxKey: rows.at(-1)!.k, rows: rows.length, sha256: sha256Hex(bytes), indexSha256: sha256Hex(footer) };
}

/** The footer length a trailer states, bounded before anything is allocated for it. */
export function decodeTrailer(trailer: Buffer, fileBytes: number): number {
  const text = trailer.toString("ascii");
  if (!/^\d{15}\n$/.test(text)) corrupt("segment trailer is malformed");
  const length = Number(text.slice(0, TRAILER_BYTES - 1));
  if (length < 2 || length > MAX_FOOTER_BYTES || length > fileBytes - TRAILER_BYTES) corrupt("segment footer length is out of range");
  return length;
}

/** Whether `value` is an object with exactly `keys`. */
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** A count in `1..max`. */
function bounded(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max;
}

const BLOCK_KEYS = ["first", "last", "offset", "length", "rows", "sha256"] as const;

/** A validated block entry at its expected offset. */
function blockEntry(value: unknown, expectedOffset: number): BlockEntry {
  if (!exactKeys(value, BLOCK_KEYS)) corrupt("segment block index entry has unexpected or missing keys");
  const valid = keyRangeValid(value.first, value.last) && value.offset === expectedOffset
    && bounded(value.length, MAX_BLOCK_BYTES) && bounded(value.rows, MAX_SEGMENT_ROWS) && isSha256(value.sha256);
  if (!valid) corrupt("segment block index entry is malformed or out of bounds");
  return value as unknown as BlockEntry;
}

/** Whether `first..last` is a valid, ordered key range. */
function keyRangeValid(first: unknown, last: unknown): boolean {
  return validKey(first) && validKey(last) && (first as string) <= (last as string);
}

/** Whether `value` is a lowercase hex SHA-256. */
function isSha256(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** Decode and validate a footer already checked against its digest. */
export function decodeFooter(footer: Buffer, dataBytes: number): SegmentFooter {
  let parsed: unknown;
  try { parsed = JSON.parse(footer.toString("utf8")); } catch { corrupt("segment footer is not JSON"); }
  if (!exactKeys(parsed, ["format", "version", "rows", "blocks"]) || parsed.format !== "llmwiki-segment" || parsed.version !== 1) {
    corrupt("segment footer is not a version 1 segment index");
  }
  if (!Array.isArray(parsed.blocks) || parsed.blocks.length === 0 || parsed.blocks.length > MAX_SEGMENT_ROWS || !bounded(parsed.rows, MAX_SEGMENT_ROWS)) {
    corrupt("segment footer block list or row count is out of bounds");
  }
  let offset = 0;
  let rows = 0;
  const blocks = (parsed.blocks as unknown[]).map((value) => {
    const block = blockEntry(value, offset);
    offset += block.length;
    rows += block.rows;
    return block;
  });
  blocks.forEach((block, at) => { if (at > 0 && !(blocks[at - 1]!.last < block.first)) corrupt("segment blocks overlap"); });
  if (offset !== dataBytes || rows !== parsed.rows) corrupt("segment block index does not cover the data exactly");
  return { rows, blocks };
}

/** One parsed row line, strictly shaped; any other JSON is typed corruption. */
function decodeRow(line: string): SegmentRow {
  let value: unknown;
  try { value = JSON.parse(line); } catch { corrupt("segment row is not JSON"); }
  if (exactKeys(value, ["k", "d"]) && validKey(value.k) && value.d === 1) return { k: value.k, d: 1 };
  if (exactKeys(value, ["k", "v"]) && validKey(value.k)) return { k: value.k, v: value.v };
  return corrupt("segment row is not a key with a value or a tombstone");
}

/** Decode a block already checked against its digest, enforcing its declared bounds and order. */
export function decodeBlock(bytes: Buffer, block: BlockEntry): SegmentRow[] {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) corrupt("segment block is torn");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length !== block.rows) corrupt("segment block row count disagrees with its index");
  const rows = lines.map(decodeRow);
  if (rows[0]!.k !== block.first || rows.at(-1)!.k !== block.last) corrupt("segment block keys disagree with its index");
  rows.forEach((row, at) => { if (at > 0 && !(rows[at - 1]!.k < row.k)) corrupt("segment block rows are out of order"); });
  return rows;
}
