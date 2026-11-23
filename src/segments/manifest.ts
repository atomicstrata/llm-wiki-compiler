/**
 * @file src/segments/manifest.ts
 * @description Strict parsing and canonical serialization of a store manifest.
 *
 * The manifest is closed: unknown keys, a future version, a wrong store name,
 * malformed digests, segment names outside the store's own pattern, unordered
 * or overlapping segments within a run, inconsistent counts, an empty run,
 * duplicate run ids, more than {@link MAX_RUNS} runs and out-of-bounds sizes or
 * keys all make it unreadable.
 *
 * AGE ORDER is the order of `runs` (oldest first). Run ids are unique labels
 * below `nextRunId` and carry no order: a merge of an older adjacent pair gets
 * a fresh id while newer runs keep theirs.
 *
 * CEILING. A manifest is at most {@link MAX_SEGMENT_MANIFEST_BYTES}; serialization
 * refuses a larger one BEFORE publication, so a store that would need more
 * segment entries than fit (roughly 2,500 with short keys) stops accepting
 * writes rather than publishing an unreadable manifest. This is a finite,
 * reported storage ceiling of the flat manifest. A store whose manifest is unreadable fails closed:
 * there is no fallback to a backup, a legacy file or an older manifest.
 */

import {
  corrupt, invalidWrite, MAX_SEGMENT_MANIFEST_BYTES, MAX_RUNS, MAX_SEGMENT_BYTES, MAX_SEGMENT_ROWS, STORE_NAME_PATTERN,
  type RunEntry, type SegmentEntry, type SegmentManifest,
} from "./contracts.js";
import { validKey } from "./format.js";

/** Segment leaf names a store writes: run id, segment index, random suffix. */
export const SEGMENT_NAME_PATTERN = /^r\d{1,12}-\d{1,6}-[0-9a-f]{8}\.seg$/;

type Fields = Record<string, unknown>;

/** An object with exactly `keys`. */
function exact(value: unknown, label: string, keys: readonly string[]): Fields {
  if (value === null || typeof value !== "object" || Array.isArray(value)) corrupt(`${label} must be an object`);
  const present = Object.keys(value);
  if (present.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) corrupt(`${label} has unexpected or missing keys`);
  return value as Fields;
}

/** A safe integer at least `min`. */
function integer(value: unknown, label: string, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) corrupt(`${label} must be an integer >= ${min}`);
  return value;
}

/** A non-empty string. */
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) corrupt(`${label} must be a non-empty string`);
  return value;
}

/** A lowercase hex SHA-256. */
function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) corrupt(`${label} must be a SHA-256`);
  return value;
}

/** One validated segment entry. */
function segment(value: unknown): SegmentEntry {
  const fields = exact(value, "segment", ["name", "minKey", "maxKey", "rows", "bytes", "sha256", "indexSha256"]);
  const name = text(fields.name, "segment.name");
  if (!SEGMENT_NAME_PATTERN.test(name)) corrupt("segment.name is not a store segment name");
  const entry: SegmentEntry = {
    name, minKey: text(fields.minKey, "segment.minKey"), maxKey: text(fields.maxKey, "segment.maxKey"),
    rows: integer(fields.rows, "segment.rows", 1), bytes: integer(fields.bytes, "segment.bytes", 1),
    sha256: digest(fields.sha256, "segment.sha256"), indexSha256: digest(fields.indexSha256, "segment.indexSha256"),
  };
  if (entry.bytes > MAX_SEGMENT_BYTES || entry.rows > MAX_SEGMENT_ROWS || !validKey(entry.minKey) || !validKey(entry.maxKey) || entry.minKey > entry.maxKey) {
    corrupt("segment bounds are invalid");
  }
  return entry;
}

/** One validated run: non-empty, sorted, non-overlapping, counts agreeing. */
function run(value: unknown, nextRunId: number): RunEntry {
  const fields = exact(value, "run", ["id", "rows", "segments"]);
  const id = integer(fields.id, "run.id", 0);
  if (id >= nextRunId) corrupt("run.id is not below nextRunId");
  if (!Array.isArray(fields.segments) || fields.segments.length === 0) corrupt("run.segments must be non-empty");
  const segments = fields.segments.map(segment);
  segments.forEach((entry, at) => { if (at > 0 && !(segments[at - 1]!.maxKey < entry.minKey)) corrupt("run segments overlap or are unordered"); });
  const rows = integer(fields.rows, "run.rows", 1);
  if (rows !== segments.reduce((sum, entry) => sum + entry.rows, 0)) corrupt("run.rows disagrees with its segments");
  return { id, rows, segments };
}

/** Validate a parsed manifest for `store`. */
function validateManifest(value: unknown, store: string): SegmentManifest {
  const fields = exact(value, "manifest", ["format", "version", "store", "generation", "nextRunId", "runs", "meta"]);
  if (fields.format !== "llmwiki-segments" || fields.version !== 1) corrupt("manifest is not a version 1 segment manifest");
  if (fields.store !== store) corrupt(`manifest belongs to store ${String(fields.store)}, not ${store}`);
  const nextRunId = integer(fields.nextRunId, "nextRunId", 0);
  return { format: "llmwiki-segments", version: 1, store, generation: integer(fields.generation, "generation", 1), nextRunId, runs: validRuns(fields.runs, nextRunId), meta: metaObject(fields.meta) };
}

/** The validated run list: at most `MAX_RUNS` runs with unique ids, each below `nextRunId`. */
function validRuns(value: unknown, nextRunId: number): RunEntry[] {
  if (!Array.isArray(value) || value.length > MAX_RUNS) corrupt(`manifest.runs must be a list of at most ${MAX_RUNS}`);
  const runs = value.map((entry) => run(entry, nextRunId));
  if (new Set(runs.map((entry) => entry.id)).size !== runs.length) corrupt("run ids must be unique");
  return runs;
}

/** The manifest's store-specific facts, which must be an object. */
function metaObject(meta: unknown): Fields {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) corrupt("manifest.meta must be an object");
  return meta as Fields;
}

/** Parse manifest bytes strictly. */
export function parseManifest(bytes: Buffer, store: string): SegmentManifest {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { corrupt("manifest is not JSON"); }
  return validateManifest(value, store);
}

/** Canonical manifest bytes (fixed key order), validated before they can be written. */
export function serializeManifest(manifest: SegmentManifest): Buffer {
  if (!STORE_NAME_PATTERN.test(manifest.store)) corrupt("store name is invalid");
  const ordered = {
    format: manifest.format, version: manifest.version, store: manifest.store, generation: manifest.generation,
    nextRunId: manifest.nextRunId, runs: manifest.runs, meta: manifest.meta,
  };
  const bytes = Buffer.from(`${JSON.stringify(ordered)}\n`, "utf8");
  if (bytes.byteLength > MAX_SEGMENT_MANIFEST_BYTES) invalidWrite(`store ${manifest.store} reached its ${MAX_SEGMENT_MANIFEST_BYTES}-byte manifest ceiling; nothing was published`);
  validateManifest(JSON.parse(bytes.toString("utf8")), manifest.store);
  return bytes;
}

/** The empty starting state of `store`; never written until the first commit. */
export function emptyManifest(store: string): SegmentManifest {
  return { format: "llmwiki-segments", version: 1, store, generation: 0, nextRunId: 0, runs: [], meta: {} };
}
