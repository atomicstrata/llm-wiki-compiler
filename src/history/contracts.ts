/**
 * @file src/history/contracts.ts
 * @description Shared names of the SEGMENTED HISTORY stores of a
 * `local-indexed` project: the event log, the relation log and each
 * workspace's operation catalog, all authoritative segment stores under
 * `.llmwiki/indexed/`.
 *
 * Each store keeps its authoritative records under one key prefix in append
 * order (`<prefix><12-digit index>`) and, in the SAME commit, the point
 * indexes its narrow operations look up. One manifest publication is
 * therefore the single commit point of a record and its indexes.
 *
 * LEGACY FILES. The incumbent single files (`wiki/graph/events.jsonl`,
 * `wiki/graph/relations.jsonl`, each workspace's catalog file) are imported
 * once, within their incumbent caps, and then left untouched as backups. A
 * store records the backup's exact path, stamp, byte count and SHA-256 at
 * import. A narrow write checks the stamp only (one confined stat, bounded);
 * full verification and activation re-hash the bytes. If the backup changed,
 * writes refuse and reads report it; it is never merged and never read as a
 * fallback.
 */

import path from "node:path";
import { isFileStamp, type FileStamp } from "../catalog/contracts.js";
import { sameStamp } from "../catalog/files.js";
import { sha256Hex } from "../segments/format.js";
import type { IoCounters } from "../segments/counters.js";
import { openConfinedLeaf, readConfinedLeafBuffer } from "../utils/confined-read.js";

/** Digits of a zero-padded record index. */
const INDEX_DIGITS = 12;
/** Most problems a verification keeps as a sample; the count is kept separately. */
export const PROBLEM_SAMPLE = 20;

/** The key of record `index` under `prefix`. */
export function indexKey(prefix: string, index: number): string {
  return `${prefix}${String(index).padStart(INDEX_DIGITS, "0")}`;
}

/** The index a record key carries after `prefix`. */
export function keyIndex(prefix: string, key: string): number {
  return Number(key.slice(prefix.length, prefix.length + INDEX_DIGITS));
}

/** The incumbent file a store was imported from, as it was at import. */
export interface LegacySnapshot {
  readonly relPath: string;
  /** `null` when there was no incumbent file (then `bytes` is 0 and `sha256` null). */
  readonly stamp: FileStamp | null;
  readonly records: number;
  readonly bytes: number;
  readonly sha256: string | null;
}

/** Whether `value` is a non-negative safe integer. */
export function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Whether `value` is an object with exactly `keys`. */
export function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => present.includes(key));
}

/** Whether `value` is a strict snapshot of the backup at exactly `relPath`. */
export function isLegacySnapshot(value: unknown, relPath: string): value is LegacySnapshot {
  if (!hasExactKeys(value, ["relPath", "stamp", "records", "bytes", "sha256"]) || value.relPath !== relPath) return false;
  if (!isCount(value.records) || !isCount(value.bytes)) return false;
  if (value.stamp === null) return value.sha256 === null && value.bytes === 0;
  return isFileStamp(value.stamp) && typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256);
}

/** What one confined look at a backup found: nothing, something unusable, or a regular file's stamp. */
type BackupStat = { kind: "absent" } | { kind: "unavailable" } | { kind: "ok"; stamp: FileStamp };

/**
 * One confined, no-follow look at the backup at `relPath` that keeps ABSENT
 * distinct from UNAVAILABLE (a link, a special file, an escaping parent, a
 * hard-linked workspace catalog): only a clean absence means "no backup".
 */
async function backupStat(root: string, relPath: string, counters: IoCounters): Promise<BackupStat> {
  counters.filesStatted += 1;
  const leaf = path.join(root, relPath);
  const opened = await openConfinedLeaf(root, leaf, path.dirname(leaf), { requireSingleLink: relPath.startsWith(".llmwiki/workspaces/") });
  if (opened.kind !== "confirmed") return opened;
  try {
    const info = await opened.handle.stat({ bigint: true });
    return { kind: "ok", stamp: { size: Number(info.size), mtimeNs: info.mtimeNs.toString(), ino: info.ino.toString() } };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/** Whether the backup is cleanly absent (a link or anything unusable is not absence). */
export async function backupAbsent(root: string, relPath: string, counters: IoCounters): Promise<boolean> {
  return (await backupStat(root, relPath, counters)).kind === "absent";
}

/** The bytes of the backup at `relPath` through the confined read, or `null` when absent; unreadable throws. */
async function legacyBytes(root: string, relPath: string, cap: number): Promise<Buffer | null> {
  const leaf = path.join(root, relPath);
  const read = await readConfinedLeafBuffer(root, leaf, path.dirname(leaf), cap);
  if (read.kind === "absent") return null;
  if (read.kind !== "ok") throw new Error(`${relPath} cannot be read within its ${cap}-byte cap`);
  return read.body;
}

/** The backup at `relPath` captured once: its snapshot (records unset) and the exact bytes to parse. */
export interface LegacyCapture {
  readonly snapshot: Omit<LegacySnapshot, "records">;
  readonly body: Buffer | null;
}

/** Capture the backup at `relPath`: stamp, exact bytes and digest, from ONE confined read. */
export async function captureLegacy(root: string, relPath: string, cap: number, counters: IoCounters): Promise<LegacyCapture> {
  const stat = await backupStat(root, relPath, counters);
  if (stat.kind === "unavailable") throw new Error(`${relPath} is not a confined regular file (a link, a special file or an escaping path); it cannot be imported`);
  if (stat.kind === "absent") return { snapshot: { relPath, stamp: null, bytes: 0, sha256: null }, body: null };
  const body = await legacyBytes(root, relPath, cap);
  if (body === null) throw new Error(`${relPath} disappeared while it was being imported`);
  return { snapshot: { relPath, stamp: stat.stamp, bytes: body.byteLength, sha256: sha256Hex(body) }, body };
}

/** Whether a look at the backup now matches the snapshot's stamp (absence matches only an absent snapshot). */
async function stampMatches(root: string, relPath: string, stamp: FileStamp | null, counters: IoCounters): Promise<boolean> {
  const stat = await backupStat(root, relPath, counters);
  if (stat.kind === "unavailable") return false;
  return stat.kind === "absent" ? stamp === null : sameStamp(stat.stamp, stamp);
}

/** Refuse when the backup changed between its capture and now (a write during the import). */
export async function assertCaptureCurrent(root: string, capture: LegacyCapture, counters: IoCounters): Promise<void> {
  if (!(await stampMatches(root, capture.snapshot.relPath, capture.snapshot.stamp, counters))) {
    throw new Error(`${capture.snapshot.relPath} changed while it was being imported; run the preparation again`);
  }
}

/** Whether the backup's stamp still matches (one confined stat; the bounded check of a narrow write). */
export async function legacyUnchanged(root: string, snapshot: LegacySnapshot, counters: IoCounters): Promise<boolean> {
  return stampMatches(root, snapshot.relPath, snapshot.stamp, counters);
}

/** Whether the backup's BYTES still hash to the snapshot (full verification and activation only). */
export async function legacyBytesUnchanged(root: string, snapshot: LegacySnapshot, cap: number): Promise<boolean> {
  const bytes = await legacyBytes(root, snapshot.relPath, cap).catch(() => undefined);
  if (bytes === undefined) return false;
  return bytes === null ? snapshot.sha256 === null : snapshot.sha256 === sha256Hex(bytes) && snapshot.bytes === bytes.byteLength;
}

/**
 * A whole-history compatibility read refused because it would exceed the
 * incumbent cap. `code` (`history_materialization_too_large`) is the stable
 * programmatic contract a caller branches on (the message may change).
 */
export class HistoryMaterializationTooLargeError extends Error {
  readonly code = "history_materialization_too_large";
  constructor(store: string, cap: number) {
    super(`history_materialization_too_large: the ${store} history exceeds the ${cap}-byte compatibility read cap; whole-history reads are refused beyond it (narrow operations use point lookups)`);
    this.name = "HistoryMaterializationTooLargeError";
  }
}

/** The message a store's refusal carries when its legacy backup changed after import. */
export function legacyDriftMessage(snapshot: LegacySnapshot): string {
  return `${snapshot.relPath} changed after it was imported into the segmented history (an older binary or an external edit wrote it); it is never merged or read as a fallback; restore it from a backup to continue writing`;
}

/** A bounded problem collector: the full count and a sample. */
export class ProblemSample {
  count = 0;
  readonly sample: string[] = [];

  /** Note one problem. */
  note(problem: string): void {
    this.count += 1;
    if (this.sample.length < PROBLEM_SAMPLE) this.sample.push(problem);
  }
}

/** A page size: a finite limit of at least 1 floored and capped at `max`; anything else is `max`. */
export function pageSize(limit: number, max: number): number {
  return Number.isFinite(limit) && limit >= 1 ? Math.min(Math.floor(limit), max) : max;
}
