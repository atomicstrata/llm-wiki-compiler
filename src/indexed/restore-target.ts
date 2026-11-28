/**
 * @file src/indexed/restore-target.ts
 * @description How a restore observes its TARGET, and how it binds a resumed
 * journal: the state of one segment or auxiliary file (with the exact file
 * identity a later unlink must still match), and the strict parse of a
 * journal against the backup's exact membership.
 */

import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { INDEXED_DIR } from "../segments/contracts.js";
import { diskSegmentStoreIo } from "../segments/io.js";
import { openConfinedLeaf } from "../utils/confined-read.js";
import { sha256Of } from "./backup-format.js";
import { IndexedRestoreError, intendedAux, type AuxStateV1, type VerifiedBackup } from "./restore-check.js";
import type { RestoreJournalV1 } from "./restore-install.js";

const HEX64 = /^[0-9a-f]{64}$/;

/** The digest of segment `name` in `store` on the target, or null when absent. */
export async function segmentState(root: string, store: string, name: string): Promise<string | null> {
  if ((await lstat(path.join(root, INDEXED_DIR, store, name)).catch(() => null)) === null) return null;
  const handle = await diskSegmentStoreIo(root, store).openSegment(name);
  const whole = await handle.readAt(0, handle.size).finally(() => handle.close());
  return sha256Of(whole);
}

/**
 * The state of auxiliary `relPath`, read through ONE confined single-link
 * open; a present file also returns a matcher of its exact identity (device,
 * inode, size, nanosecond mtime and ctime) for an identity-bound unlink.
 */
export async function currentAux(root: string, relPath: string, cap: number): Promise<{ state: AuxStateV1; identity?: (stat: BigIntStats) => boolean }> {
  const leaf = path.join(root, relPath);
  const opened = await openConfinedLeaf(root, leaf, path.dirname(leaf), { requireSingleLink: true });
  if (opened.kind === "absent") return { state: { state: "absent" } };
  if (opened.kind !== "confirmed") throw new IndexedRestoreError("indexed_restore_conflict", `auxiliary file ${relPath} is not a confined regular single-link file`);
  try {
    const stat = await opened.handle.stat({ bigint: true });
    if (stat.size > BigInt(cap)) throw new IndexedRestoreError("indexed_restore_conflict", `auxiliary file ${relPath} is larger than its cap`);
    // Allocate for the observed size (plus one byte to detect growth), never the whole kind cap.
    const body = await boundedRead(opened.handle, Math.min(cap, Number(stat.size)));
    if (body.byteLength !== Number(stat.size)) throw new IndexedRestoreError("indexed_restore_conflict", `auxiliary file ${relPath} changed while it was read`);
    const identity = (now: BigIntStats) => now.dev === stat.dev && now.ino === stat.ino && now.size === stat.size && now.mtimeNs === stat.mtimeNs && now.ctimeNs === stat.ctimeNs;
    return { state: { state: "present", sha256: sha256Of(body) }, identity };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/** Read at most `cap + 1` bytes from `handle`, refusing more than `cap` (the caller passes the observed size, so growth is refused). */
async function boundedRead(handle: import("node:fs/promises").FileHandle, cap: number): Promise<Buffer> {
  const buffer = Buffer.alloc(cap + 1);
  let filled = 0;
  for (let read = -1; read !== 0 && filled < buffer.length; filled += read) read = (await handle.read(buffer, filled, buffer.length - filled, filled)).bytesRead;
  if (filled > cap) throw new IndexedRestoreError("indexed_restore_conflict", "an auxiliary file grew past its cap while it was read");
  return buffer.subarray(0, filled);
}

/** Refuse a resumed journal that is malformed or does not bind exactly this backup's membership. */
function malformed(why: string): never {
  throw new IndexedRestoreError("indexed_restore_conflict", `the interrupted restore's journal ${why}; nothing more was changed`);
}

/** Whether `value` is a digest or null. */
const digestOrNull = (value: unknown): boolean => value === null || (typeof value === "string" && HEX64.test(value));

/** Whether `value` is an auxiliary state. */
function isAuxState(value: unknown): value is AuxStateV1 {
  const state = value as { state?: unknown; sha256?: unknown } | null;
  return state !== null && typeof state === "object" && (state.state === "absent" || (state.state === "present" && typeof state.sha256 === "string" && HEX64.test(state.sha256)));
}

/** Parse a resumed journal strictly, bound to `backup`'s exact stores, segments and auxiliary files. */
export function bindJournal(value: unknown, backup: VerifiedBackup): RestoreJournalV1 {
  try {
    return bindJournalStrict(value, backup);
  } catch (error) {
    if (error instanceof IndexedRestoreError) throw error;
    return malformed("is malformed"); // a null or mis-shaped row: typed, before any effect
  }
}

/** Whether `journal` has the journal's outer shape (a digest and the three lists). */
function journalShaped(journal: RestoreJournalV1 | null): journal is RestoreJournalV1 {
  if (journal === null || typeof journal !== "object" || typeof journal.scaleRecordSha256 !== "string") return false;
  return HEX64.test(journal.scaleRecordSha256) && [journal.stores, journal.segments, journal.aux].every(Array.isArray);
}

/** `items` mapped by `label`, sorted and joined: an order-free fingerprint of a list. */
const fingerprint = <T>(items: readonly T[], label: (item: T) => string): string => items.map(label).sort().join();

/** Whether the journal's stores are exactly the backup's, each with valid digests. */
function bindsStores(journal: RestoreJournalV1, backup: VerifiedBackup): boolean {
  return fingerprint(journal.stores, (s) => `${s.store}`) === [...backup.manifests.keys()].sort().join() && journal.stores.every((s) => digestOrNull(s.original) && digestOrNull(s.intended));
}

/** Whether the journal's segments are exactly the backup's planned ones. */
function bindsSegments(journal: RestoreJournalV1, backup: VerifiedBackup): boolean {
  const planned = backup.index.stores.flatMap((s) => s.segments.map((segment) => `${s.store}/${segment.name}:${segment.sha256}`)).sort().join();
  return fingerprint(journal.segments, (s) => `${s.store}/${s.name}:${s.intended}`) === planned && journal.segments.every((s) => digestOrNull(s.original));
}

/** Whether the journal's auxiliary entries are exactly the backup's intended ones. */
function bindsAux(journal: RestoreJournalV1, backup: VerifiedBackup): boolean {
  const aux = fingerprint(backup.index.auxiliary, (a) => `${a.relPath}:${JSON.stringify(intendedAux(a))}`);
  return fingerprint(journal.aux, (a) => `${a.relPath}:${JSON.stringify(a.intended)}`) === aux && journal.aux.every((a) => isAuxState(a.original) && isAuxState(a.intended));
}

/** The body of {@link bindJournal}; any shape fault may throw untyped and is converted by the caller. */
function bindJournalStrict(value: unknown, backup: VerifiedBackup): RestoreJournalV1 {
  const journal = value as RestoreJournalV1 | null;
  if (!journalShaped(journal)) return malformed("is malformed");
  if (!bindsStores(journal, backup)) malformed("does not bind this backup's stores");
  if (!bindsSegments(journal, backup)) malformed("does not bind this backup's segments");
  if (!bindsAux(journal, backup)) malformed("does not bind this backup's auxiliary files");
  return journal;
}
