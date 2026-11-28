/**
 * @file src/scale/record.ts
 * @description Reading and writing the scale record through the project's
 * confined private directory.
 *
 * READ. The existing `.llmwiki` is resolved WITHOUT creating it and confined
 * (a link escaping the root is a refusal, reported as unreadable, never
 * followed); the leaf is read through the shared capped, no-follow,
 * regular-file read. Absence is the ONLY outcome that means "no record": a
 * link, a non-regular leaf, an oversized leaf, a failed read and every schema
 * violation are `unreadable`, and callers fail closed on it.
 *
 * Both versions are read: version 1 under its frozen parser and policy,
 * version 2 under `local-v2` (`./record-v2-schema.ts`).
 *
 * WRITE. The record is validated before serialization, then published by one
 * atomic replacement within the root. Callers write only while holding the
 * project mutation lock.
 *
 * ONE BODY. {@link readScaleRecordFrom} and {@link writeScaleRecordFrom} take a
 * {@link ScaleRecordIo} and no project root; {@link diskScaleRecordIo} is the
 * local binding. {@link hasScaleRecord} is the cheap presence probe the gates
 * use first: one `lstat`, so a project without a record pays nothing more.
 */

import { lstat } from "node:fs/promises";
import path from "node:path";
import { replaceLeafAtomicWithin } from "../storage/disk-guarded-leaves.js";
import { readPrivateLeafText } from "../storage/disk-private-leaves.js";
import type { CappedLeafRead } from "../utils/confined-read.js";
import { resolveConfinedPrivateDir, resolveExistingConfinedPrivateDir } from "../utils/private-dir.js";
import { isDeepStrictEqual } from "node:util";
import { atomicWrite, AtomicWritePostCommitError } from "../utils/atomic-write.js";
import { MAX_SCALE_RECORD_BYTES, SCALE_RECORD_FILE, ScaleRefusalError } from "./contracts.js";

/** Where the `local-indexed` stores live (mirrors `segments/contracts.ts`, which this module must not import). */
const INDEXED_STORES_DIR = ".llmwiki/indexed";
import type { ScaleRecord } from "./contracts-v2.js";
import { ScaleRecordSchemaError } from "./record-schema.js";
import { parseAnyScaleRecord, serializeAnyScaleRecord } from "./record-v2-schema.js";

/** One read of the record: absent, unreadable (fail closed), or a validated record. */
export type ScaleRecordRead =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly reason: string }
  | { readonly kind: "ok"; readonly record: ScaleRecord };

/** The physical mechanisms the record body runs over. No member takes a project root or decides anything. */
export interface ScaleRecordIo {
  /** The existing private directory, or `null` when there is none. REJECTS on a confinement fault. */
  resolvePrivateDir(): Promise<string | null>;
  /** The capped no-follow text read of one leaf of a resolved private directory. Never rejects. */
  readLeaf(dir: string, name: string, maxBytes: number): Promise<CappedLeafRead>;
  /** Create the private directory when missing, confined. REJECTS on a confinement fault. */
  createPrivateDir(): Promise<void>;
  /** Atomically replace the project-relative leaf. REJECTS raw. */
  replaceLeaf(relPath: string, content: string): Promise<void>;
  /**
   * OPTIONAL: replace the leaf strictly durably and privately, but only if the
   * record on disk is still `expected` (checked at the writer's last
   * pre-publication seam). Used for every version 2 record, whose activation
   * is the `local-indexed` publication fence. Absent in test doubles.
   */
  replaceLeafConditional?(relPath: string, content: string, expected: ScaleRecord | null): Promise<void>;
}

/** LOCAL DISK. The incumbent confined resolvers, capped no-follow read and atomic replace for `root`. Building it does no I/O. */
export function diskScaleRecordIo(root: string): ScaleRecordIo {
  return {
    resolvePrivateDir: () => resolveExistingConfinedPrivateDir(root),
    readLeaf: (dir, name, maxBytes) => readPrivateLeafText(path.join(dir, name), maxBytes),
    createPrivateDir: async () => { await resolveConfinedPrivateDir(root); },
    replaceLeaf: (relPath, content) => replaceLeafAtomicWithin(root, path.join(root, relPath), content),
    replaceLeafConditional: (relPath, content, expected) => replaceRecordConditionally(root, relPath, content, expected),
  };
}

/** The record on disk now, parsed, or null when absent; anything unreadable counts as a different record. */
async function currentRecord(root: string): Promise<ScaleRecord | null | "unreadable"> {
  const read = await readScaleRecordFrom(diskScaleRecordIo(root));
  return read.kind === "ok" ? read.record : read.kind === "absent" ? null : "unreadable";
}

/**
 * Durable, private, conditional replacement of a version 2 record. A record
 * that changed since it was read refuses (`scale_revision_conflict`, nothing
 * published). Any other failure is `scale_outcome_unknown` unless a re-read
 * proves the previous record is still in place; a failure AFTER the rename
 * (`AtomicWritePostCommitError`) is always unknown. Never a silent success,
 * an implied "unchanged" or a blind retry. The final comparison runs at the atomic writer's LAST seam
 * (`beforeReplace`, after the durable temp, immediately before the rename).
 */
async function replaceRecordConditionally(root: string, relPath: string, content: string, expected: ScaleRecord | null): Promise<void> {
  const revalidate = async () => {
    if (!isDeepStrictEqual(await currentRecord(root), expected)) throw new ScaleRefusalError("scale_revision_conflict", "the scale record changed after it was read; nothing was published");
  };
  try {
    await atomicWrite(path.join(root, relPath), content, { confineRoot: root, exactParent: true, durable: true, strictDurability: true, mode: 0o600, beforeReplace: revalidate });
  } catch (error) {
    if (error instanceof ScaleRefusalError) throw error;
    // Only a re-read that PROVES the previous record is still in place lets the raw error mean "nothing published".
    const after = await currentRecord(root).catch(() => "unreadable" as const);
    const unchanged = !(error instanceof AtomicWritePostCommitError) && after !== "unreadable" && isDeepStrictEqual(after, expected);
    if (!unchanged) throw new ScaleRefusalError("scale_outcome_unknown", `the record may have been published but it could not be confirmed; read the scale status before retrying (${error instanceof Error ? error.message : String(error)})`);
    throw error;
  }
}

/** Read the record over `io`: THE ONE BODY. Only absence means "no record". */
export async function readScaleRecordFrom(io: ScaleRecordIo): Promise<ScaleRecordRead> {
  let dir: string | null;
  try { dir = await io.resolvePrivateDir(); } catch { return { kind: "unreadable", reason: "the private directory is not confined" }; }
  if (dir === null) return { kind: "absent" };
  const leaf = await io.readLeaf(dir, path.basename(SCALE_RECORD_FILE), MAX_SCALE_RECORD_BYTES);
  if (leaf.kind === "absent") return { kind: "absent" };
  if (leaf.kind === "unavailable") return { kind: "unreadable", reason: `${SCALE_RECORD_FILE} is a link, not a regular file, oversized or unreadable` };
  try {
    return { kind: "ok", record: parseAnyScaleRecord(leaf.body) };
  } catch (error) {
    if (error instanceof ScaleRecordSchemaError) return { kind: "unreadable", reason: `${SCALE_RECORD_FILE}: ${error.message}` };
    throw error;
  }
}

/**
 * Validate, then atomically publish, the record over `io`: THE ONE BODY. A
 * version 1 record (or one replacing a version 1 record) keeps the incumbent
 * replacement, byte for byte. A version 2 or 3 record, or one replacing one,
 * goes through the conditional durable replacement against
 * `previous` (the record the caller read under the lock).
 */
export async function writeScaleRecordFrom(io: ScaleRecordIo, record: ScaleRecord, previous?: ScaleRecord | null): Promise<void> {
  const text = serializeAnyScaleRecord(record);
  await io.createPrivateDir();
  const conditional = record.version !== 1 || (previous !== undefined && previous !== null && previous.version !== 1);
  if (conditional && io.replaceLeafConditional !== undefined && previous !== undefined) return io.replaceLeafConditional(SCALE_RECORD_FILE, text, previous);
  await io.replaceLeaf(SCALE_RECORD_FILE, text);
}

/** Read the record of the project at `root`. */
export function readScaleRecord(root: string): Promise<ScaleRecordRead> {
  return readScaleRecordFrom(diskScaleRecordIo(root));
}

/** What one no-follow `lstat` finds: nothing, a real directory, or anything else (a link, a file, a fault). */
async function lstatKind(location: string): Promise<"absent" | "directory" | "other"> {
  try {
    return (await lstat(location)).isDirectory() ? "directory" : "other";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "other";
  }
}

/**
 * Whether anything may be at `.llmwiki/indexed` (the `local-indexed` stores):
 * one no-follow `lstat`; only a clean ENOENT/ENOTDIR proves absence. Indexed
 * stores without a readable record fail closed everywhere (gate, routes,
 * lock-free writers), because the incumbent files there may be stale.
 */
export async function indexedStoresMayExist(root: string): Promise<boolean> {
  try {
    await lstat(path.join(root, INDEXED_STORES_DIR));
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

/**
 * Whether the project MAY carry a record, by at most two no-follow `lstat`s.
 * No `.llmwiki`, or a real `.llmwiki` with nothing at the record's leaf, is
 * "no record". A `.llmwiki` that is a link (dangling, escaping or not), or is
 * not a directory, or any fault, answers "present": the confined full read
 * then decides, and fails closed when it cannot resolve the private directory,
 * so an opted-in project is never mistaken for an un-opted one. Records are
 * never deleted by this product, so a `true` answer never becomes `false`.
 */
export async function hasScaleRecord(root: string): Promise<boolean> {
  const privateDir = await lstatKind(path.join(root, path.dirname(SCALE_RECORD_FILE)));
  if (privateDir !== "directory") return privateDir === "other";
  return (await lstatKind(path.join(root, SCALE_RECORD_FILE))) !== "absent";
}
