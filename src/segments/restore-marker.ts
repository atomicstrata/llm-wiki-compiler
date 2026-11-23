/**
 * @file src/segments/restore-marker.ts
 * @description The durable RESTORE MARKER of an indexed-authority restore,
 * `.llmwiki/indexed-restore.json`, and the private scope in which only the
 * restore that owns it may read the stores.
 *
 * While a marker exists, every indexed read (after its reader lease), every
 * routed operation and every mutation gate refuses: `indexed_restore_in_progress`
 * while its owner runs or before any effect, `indexed_restore_incomplete`
 * once installation began and its owner is gone (re-run the same restore).
 * The marker is written before the reader census, so no pre-restore snapshot
 * can be read once installation begins.
 *
 * The marker also carries the restore's JOURNAL (original and intended
 * states), so a resumed restore accepts only those states and never adopts a
 * target it did not record. Every rewrite or removal re-checks, at the atomic
 * writer's last seam, that the marker on disk still carries this restore's
 * token.
 *
 * SCOPE. Only code running inside {@link runWithRestoreAccess} with the
 * marker's token is admitted (async-context scoped, never process-wide and
 * never an option), so concurrent SDK calls in the same process still refuse.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../utils/atomic-write.js";
import { openConfinedLeaf } from "../utils/confined-read.js";
import { unlinkConfinedLeafIfIdentity, fsyncConfinedDirectory } from "../utils/confined-delete.js";
import { classifyOwnerLiveness, parseOwner } from "../utils/lock-owner.js";
import { IndexedStoreError } from "./contracts.js";

/** The marker leaf, relative to the project root. */
const RESTORE_MARKER = ".llmwiki/indexed-restore.json";
const MARKER_FORMAT = "llmwiki-indexed-restore-marker";
/** A marker (with its journal) is small; anything larger is not ours. */
export const MAX_MARKER_BYTES = 4 * 1024 * 1024;

/** Where a restore stands. Only `preflight` means no effect can have begun. */
export type RestorePhase = "preflight" | "installing-files" | "installing-manifests" | "verified";

/** The durable marker. `journal` is the restore's own record, opaque here. */
export interface RestoreMarkerV1 {
  readonly format: typeof MARKER_FORMAT;
  readonly version: 1;
  readonly token: string;
  readonly backupDigest: string;
  readonly phase: RestorePhase;
  /** The owner record (`lock-owner` format) of the restoring process. */
  readonly owner: unknown;
  readonly journal: unknown;
}

/** What one look at the marker found. */
export type MarkerRead = { readonly kind: "absent" } | { readonly kind: "ok"; readonly marker: RestoreMarkerV1 } | { readonly kind: "unreadable" };

const scope = new AsyncLocalStorage<{ readonly root: string; readonly token: string }>();

/** Run `body` as the restore holding `token` for canonical `root`: only it may read past the marker. */
export function runWithRestoreAccess<T>(root: string, token: string, body: () => Promise<T>): Promise<T> {
  return scope.run({ root, token }, body);
}

/** Whether the caller is the restore owning canonical `root`'s marker: inside its scope, with the marker PRESENT and carrying the scope's token. */
export async function holdsRestoreMarker(root: string): Promise<boolean> {
  const mine = scope.getStore();
  if (mine?.root !== root) return false;
  const read = await readRestoreMarker(root);
  return read.kind === "ok" && read.marker.token === mine.token;
}

/** Whether `value` is a closed-shape marker this build wrote (its journal is checked by the restore). */
function isMarker(value: unknown): value is RestoreMarkerV1 {
  if (!hasMarkerKeys(value)) return false;
  const phases: readonly unknown[] = ["preflight", "installing-files", "installing-manifests", "verified"];
  const identity = value.format === MARKER_FORMAT && value.version === 1 && hexOf(value.token, 32) && hexOf(value.backupDigest, 64);
  return identity && phases.includes(value.phase) && parseOwner(JSON.stringify(value.owner ?? null)) !== null;
}

/** Whether `value` is a plain object with exactly a marker's keys. */
function hasMarkerKeys(value: unknown): value is Record<string, unknown> {
  const keys = "backupDigest,format,journal,owner,phase,token,version";
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === keys;
}

/** Whether `value` is a lowercase hex string of exactly `length` digits. */
function hexOf(value: unknown, length: number): boolean {
  return typeof value === "string" && value.length === length && /^[0-9a-f]+$/.test(value);
}

/** A marker leaf's exact identity: the file and its content stamp (an in-place rewrite changes the stamp). */
interface MarkerIdentity { readonly dev: bigint; readonly ino: bigint; readonly size: bigint; readonly mtimeNs: bigint; readonly ctimeNs: bigint }

/** The identity of a bigint stat. */
function identityOf(stat: BigIntStats): MarkerIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

/** Whether `stat` is still exactly `identity` (same file, unchanged content stamp). */
function sameIdentity(identity: MarkerIdentity, stat: BigIntStats): boolean {
  const now = identityOf(stat);
  return now.dev === identity.dev && now.ino === identity.ino && now.size === identity.size && now.mtimeNs === identity.mtimeNs && now.ctimeNs === identity.ctimeNs;
}

/** The marker and the exact identity of the leaf its bytes were read from, through ONE confined open. */
async function readMarkerWithIdentity(root: string): Promise<{ read: MarkerRead; identity?: MarkerIdentity }> {
  const leaf = path.join(root, RESTORE_MARKER);
  const opened = await openConfinedLeaf(root, leaf, path.dirname(leaf), { requireSingleLink: true });
  if (opened.kind === "absent") return { read: { kind: "absent" } };
  if (opened.kind !== "confirmed") return { read: { kind: "unreadable" } };
  try {
    const stat = await opened.handle.stat({ bigint: true });
    if (stat.size > BigInt(MAX_MARKER_BYTES)) return { read: { kind: "unreadable" } };
    const value = JSON.parse((await opened.handle.readFile()).toString("utf8")) as unknown;
    return { read: isMarker(value) ? { kind: "ok", marker: value } : { kind: "unreadable" }, identity: identityOf(stat) };
  } catch {
    return { read: { kind: "unreadable" } };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/** Read the marker of canonical `root` strictly. */
export async function readRestoreMarker(root: string): Promise<MarkerRead> {
  return (await readMarkerWithIdentity(root)).read;
}

/** Whether the marker's owner is positively gone (a dead or reused pid). */
export function markerOwnerStale(marker: RestoreMarkerV1): boolean {
  const owner = parseOwner(JSON.stringify(marker.owner ?? null));
  return owner !== null && classifyOwnerLiveness(owner) === "stale";
}

/**
 * The refusal a marker at canonical `root` implies for a caller outside its
 * restore scope, or `null` when there is no marker (one `lstat`) or the
 * caller is that restore.
 */
export async function restoreRefusal(root: string): Promise<IndexedStoreError | null> {
  const present = await lstat(path.join(root, RESTORE_MARKER)).then(() => true, (error: NodeJS.ErrnoException) => error.code !== "ENOENT");
  if (!present) return null;
  const read = await readRestoreMarker(root);
  if (read.kind === "absent") return null;
  const mine = scope.getStore();
  if (read.kind === "ok" && mine?.root === root && mine.token === read.marker.token) return null;
  if (read.kind === "ok" && read.marker.phase !== "preflight" && markerOwnerStale(read.marker)) {
    return new IndexedStoreError("indexed_restore_incomplete", `an indexed-authority restore stopped during ${read.marker.phase}; re-run the same \`llmwiki catalog restore\` to finish it`);
  }
  return new IndexedStoreError("indexed_restore_in_progress", `an indexed-authority restore holds ${RESTORE_MARKER}; nothing was read or changed`);
}

/** Refuse (see {@link restoreRefusal}) unless canonical `root` has no foreign restore marker. */
export async function assertNoForeignRestore(root: string): Promise<void> {
  const refusal = await restoreRefusal(root);
  if (refusal !== null) throw refusal;
}

/** Refuse unless the marker on disk still carries `token` (the last-seam check of every rewrite and removal). */
async function assertMarkerToken(root: string, token: string | null): Promise<void> {
  const read = await readRestoreMarker(root);
  const current = read.kind === "ok" ? read.marker.token : read.kind === "absent" ? null : "<unreadable>";
  if (current !== token) throw new IndexedStoreError("indexed_restore_in_progress", "the restore marker changed under this restore; nothing more was written");
}

/**
 * Durably write `marker`: create it when `expectedToken` is null (refusing an
 * existing marker), or replace the marker carrying `expectedToken`.
 */
export async function writeRestoreMarker(root: string, marker: RestoreMarkerV1, expectedToken: string | null): Promise<void> {
  const leaf = path.join(root, RESTORE_MARKER);
  const bytes = `${JSON.stringify(marker)}\n`;
  if (Buffer.byteLength(bytes) > MAX_MARKER_BYTES) throw new IndexedStoreError("indexed_store_invalid_write", "the restore journal is larger than its marker cap");
  if (expectedToken === null) {
    await atomicWrite(leaf, bytes, { confineRoot: root, exactParent: true, createOnly: true, mode: 0o600 });
    return;
  }
  await atomicWrite(leaf, bytes, { confineRoot: root, exactParent: true, durable: true, strictDurability: true, mode: 0o600, beforeReplace: () => assertMarkerToken(root, expectedToken) });
}

/**
 * Durably remove the marker carrying `token`. The token is read from the same
 * opened leaf whose identity (device, inode, size, nanosecond mtime and
 * ctime) the unlink then requires at its last seam, so a marker replaced or
 * rewritten in place between the check and the removal is never deleted.
 */
export async function removeRestoreMarker(root: string, token: string): Promise<void> {
  const { read, identity } = await readMarkerWithIdentity(root);
  if (read.kind !== "ok" || read.marker.token !== token || identity === undefined) {
    throw new IndexedStoreError("indexed_restore_in_progress", "the restore marker is not this restore's; nothing was removed");
  }
  const leaf = path.join(root, RESTORE_MARKER);
  const removed = await unlinkConfinedLeafIfIdentity(root, leaf, path.dirname(leaf), (now) => sameIdentity(identity, now));
  if (removed !== "unlinked") throw new IndexedStoreError("indexed_restore_in_progress", "the restore marker changed while it was being removed; nothing was removed");
  await fsyncConfinedDirectory(root, path.dirname(leaf));
}
