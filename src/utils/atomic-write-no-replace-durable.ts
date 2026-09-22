/**
 * @file Internal durable recovery helpers for create-only atomic writes.
 * @description Reconciles the target-specific durable temporary leaf, binds
 * every recovery operation to the captured parent directory, and preserves
 * the public error types re-exported by `atomic-write.ts`.
 */

import { link, lstat, open, unlink } from "fs/promises";
import { constants as fsConstants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { assertCurrentParent, fsyncDirectoryChain, type ParentBinding } from "./atomic-write-durability.js";

/** One target-specific durable temp makes every crash state directly addressable. */
const DURABLE_TEMP_SUFFIX = ".tmp";

/** Fixed disposable scratch leaf used before the immutable ready alias exists. */
const DURABLE_WRITING_SUFFIX = ".writing";

/** Typed signal that a no-replace destination already owns the requested name. */
export class AtomicWriteCollisionError extends Error {
  constructor() {
    super("atomic no-replace destination already exists");
    this.name = "AtomicWriteCollisionError";
  }
}

/** Destination committed, but its same-directory temporary alias could not be removed. */
export class AtomicWriteCommittedCleanupError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("atomic no-replace destination committed but temporary alias cleanup failed");
    this.name = "AtomicWriteCommittedCleanupError";
    this.cause = cause;
  }
}

/** Internal durable-only hooks and metadata for create-only recovery. */
export interface DurableNoReplaceRecoveryOptions {
  mode?: number;
  afterCommit?: () => Promise<void>;
  beforeDirectorySync?: (dir: string) => Promise<void>;
}

/**
 * A published durable destination whose inode is still pinned by an open
 * handle, so its identity can be verified live through the final recheck.
 */
export interface PublishedDurable {
  handle: FileHandle;
  stat: Stats;
}

/** Return the sole durable temp path reserved for one destination. */
export function durableTempPath(filePath: string): string {
  return `${filePath}${DURABLE_TEMP_SUFFIX}`;
}

/** Return the non-authoritative scratch leaf for one durable publication. */
export function durableWritingPath(filePath: string): string {
  return `${filePath}${DURABLE_WRITING_SUFFIX}`;
}

/** Reconcile every directly addressable durable temp state before new publication. */
export async function recoverDurableTemp(
  filePath: string,
  content: Buffer,
  options: DurableNoReplaceRecoveryOptions | undefined,
  binding: ParentBinding | undefined,
): Promise<PublishedDurable | undefined> {
  const tmpPath = durableTempPath(filePath);
  await discardDurableScratch(durableWritingPath(filePath), tmpPath, binding);
  const destination = await lstatBoundIfPresent(filePath, binding);
  const temporary = await lstatBoundIfPresent(tmpPath, binding);
  if (destination !== undefined) {
    await reconcileCommittedDurableTemp(tmpPath, temporary, destination, binding, options?.beforeDirectorySync);
    throw new AtomicWriteCollisionError();
  }
  if (temporary === undefined) return undefined;
  return promoteDurableTemp(filePath, tmpPath, content, options, binding);
}

/**
 * Reconcile the deterministic durable temp alias of one streamed
 * content-addressed leaf before a fresh streaming attempt, so a post-link crash
 * is replayable rather than permanently poisoned. A crash after the temp was
 * linked to the digest name but before it was removed leaves the authoritative
 * object at nlink=2, which the single-link evidence reader rejects and a
 * create-only relink cannot repair; this removes the temp only when it still
 * names the published inode, restoring nlink=1 and reporting a collision the
 * caller resolves by exact re-read. A leftover temp whose destination is absent
 * (crash before the destination link) is discarded so the retry re-streams. A
 * foreign hardlink is rejected, never silently accepted or removed.
 */
export async function recoverStreamedDurableTemp(
  filePath: string,
  binding: ParentBinding | undefined,
  beforeDirectorySync: ((dir: string) => Promise<void>) | undefined,
): Promise<void> {
  const tmpPath = durableTempPath(filePath);
  const destination = await lstatBoundIfPresent(filePath, binding);
  const temporary = await lstatBoundIfPresent(tmpPath, binding);
  if (destination !== undefined) {
    await reconcileCommittedDurableTemp(tmpPath, temporary, destination, binding, beforeDirectorySync);
    throw new AtomicWriteCollisionError();
  }
  if (temporary !== undefined) await discardStreamedDurableTemp(tmpPath, temporary, binding);
}

/** Remove a leftover streamed temp with no destination, rejecting foreign aliases. */
async function discardStreamedDurableTemp(
  tmpPath: string,
  temporary: Stats,
  binding: ParentBinding | undefined,
): Promise<void> {
  try {
    if (!temporary.isFile() || temporary.isSymbolicLink()) throw new Error("streamed durable temp is not regular");
    if (temporary.nlink !== 1) throw new Error("streamed durable temp has an external alias");
    await assertTempPathBound(tmpPath, binding, temporary);
    await unlink(tmpPath);
    await fsyncDirectoryChain(path.dirname(tmpPath), binding);
  } catch (error) {
    throw new AtomicWriteCommittedCleanupError(error);
  }
}

/** Sync an existing regular destination before durable collision is reported. */
export async function syncExistingCollision(
  filePath: string,
  content: Buffer,
  mode: number | undefined,
  binding: ParentBinding | undefined,
  beforeSync: (() => Promise<void>) | undefined,
): Promise<void> {
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const expected = await handle.stat();
    if (!isExactCollisionCandidate(expected, content, mode)) return;
    await assertTempPathBound(filePath, binding, expected);
    if (!(await hasExactHandleBytes(handle, expected, content))) return;
    await assertTempPathBound(filePath, binding, expected);
    await beforeSync?.();
    await handle.sync();
    await assertTempPathBound(filePath, binding, expected);
  } finally {
    await handle.close();
  }
}

/** Link a synced disposable scratch inode into the immutable ready namespace. */
export async function linkWritingAsReady(
  writingPath: string,
  tmpPath: string,
  binding: ParentBinding | undefined,
  expected: Stats,
): Promise<void> {
  try {
    await assertTempPathBound(writingPath, binding, expected);
    await link(writingPath, tmpPath);
  } catch (error) {
    throw new AtomicWriteCommittedCleanupError(error);
  }
}

/** Link one completed same-directory temp as the no-replace commit point. */
export async function linkTempNoReplace(tmpPath: string, filePath: string): Promise<void> {
  try {
    await link(tmpPath, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new AtomicWriteCollisionError();
    }
    throw error;
  }
}

/** Remove only the still-bound committed temp alias under the portable race limit. */
export async function removeCommittedTemp(
  tmpPath: string,
  binding: ParentBinding | undefined,
  expected: Stats,
): Promise<void> {
  try {
    await assertTempPathBound(tmpPath, binding, expected);
    await unlink(tmpPath);
  } catch (error) {
    throw new AtomicWriteCommittedCleanupError(error);
  }
}

/** Verify the temp path still refers to the expected in-parent inode. */
export async function assertTempPathBound(
  tmpPath: string,
  binding: ParentBinding | undefined,
  expected: Stats,
): Promise<void> {
  if (binding !== undefined) await assertCurrentParent(binding);
  const pathStat = await lstat(tmpPath);
  if (pathStat.dev !== expected.dev || pathStat.ino !== expected.ino) {
    throw new Error(`temporary write handle is not bound to the confined path: ${tmpPath}`);
  }
}

/**
 * Verify the destination still names the prepared inode, read live from the
 * open write handle that pins it. Holding the handle keeps the inode's number
 * from being freed and reused by a same-UID racer between publication and this
 * check (a closed-handle snapshot could be satisfied by a reused inode number
 * on allocators that recycle eagerly, e.g. Linux). This portable same-UID check
 * detects replacement before return; it is not a sandbox or a native lease
 * against a same-UID actor racing after the final check.
 */
export async function assertPublishedDestination(
  filePath: string,
  handle: FileHandle,
  binding: ParentBinding | undefined,
): Promise<void> {
  try {
    if (binding !== undefined) await assertCurrentParent(binding);
    const expected = await handle.stat();
    const actual = await lstat(filePath);
    if (actual.dev === expected.dev && actual.ino === expected.ino) return;
  } catch {
    // Normalize absence, symlink swaps, and unreadable leaves to one refusal.
  }
  throw new Error(`atomic destination changed after publication: ${filePath}`);
}

/** Require the final authoritative name to be the inode's sole remaining link. */
export async function assertSettledDestination(
  filePath: string,
  handle: FileHandle,
  binding: ParentBinding | undefined,
): Promise<void> {
  await assertPublishedDestination(filePath, handle, binding);
  const expected = await handle.stat();
  const actual = await lstat(filePath);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.nlink !== 1) {
    throw new Error(`atomic destination has an external alias: ${filePath}`);
  }
}

/**
 * Remove one committed temp link only when it still names the destination inode,
 * fsyncing the parent both before and AFTER the unlink so the reconciliation is
 * power-loss durable: an un-fsynced removal could resurrect the `.tmp` alias at
 * nlink=2 after reported reconciliation, which the single-link evidence reader
 * would then reject.
 */
async function reconcileCommittedDurableTemp(
  tmpPath: string,
  temporary: Stats | undefined,
  destination: Stats,
  binding: ParentBinding | undefined,
  beforeDirectorySync: ((dir: string) => Promise<void>) | undefined,
): Promise<void> {
  if (temporary === undefined) return;
  try {
    if (!destination.isFile() || destination.isSymbolicLink()) throw new Error("collision destination is not regular");
    if (destination.nlink !== 2) throw new Error("collision destination has an external alias");
    await assertTempPathBound(tmpPath, binding, destination);
    await fsyncDirectoryChain(path.dirname(tmpPath), binding, beforeDirectorySync);
    await unlink(tmpPath);
    await fsyncDirectoryChain(path.dirname(tmpPath), binding, beforeDirectorySync);
  } catch (error) {
    throw new AtomicWriteCommittedCleanupError(error);
  }
}

/**
 * Remove a stale regular scratch before examining the immutable ready alias.
 * The pre-unlink identity check is the portable same-UID bound; it is not a
 * native lease against a same-UID actor racing the unlink itself.
 */
async function discardDurableScratch(
  writingPath: string,
  readyPath: string,
  binding: ParentBinding | undefined,
): Promise<void> {
  if (binding !== undefined) await assertCurrentParent(binding);
  try {
    const scratch = await lstat(writingPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (scratch === undefined) return;
    if (!scratch.isFile() || scratch.isSymbolicLink()) throw new Error("durable scratch is not a regular file");
    if (!(await hasOnlyReservedReadyAlias(scratch, readyPath, binding))) {
      throw new Error("durable scratch has an external alias");
    }
    await assertTempPathBound(writingPath, binding, scratch);
    await unlink(writingPath);
    await fsyncDirectoryChain(path.dirname(writingPath), binding);
  } catch (error) {
    throw new AtomicWriteCommittedCleanupError(error);
  }
}

/** Accept one link, or exactly the writing+ready pair created by this protocol. */
async function hasOnlyReservedReadyAlias(
  scratch: Stats,
  readyPath: string,
  binding: ParentBinding | undefined,
): Promise<boolean> {
  if (scratch.nlink === 1) return true;
  if (scratch.nlink !== 2) return false;
  const ready = await lstatBoundIfPresent(readyPath, binding);
  return ready !== undefined && ready.isFile() && !ready.isSymbolicLink()
    && ready.dev === scratch.dev && ready.ino === scratch.ino;
}

/** Promote an exact synced temp-only crash state through the normal commit point. */
async function promoteDurableTemp(
  filePath: string,
  tmpPath: string,
  content: Buffer,
  options: DurableNoReplaceRecoveryOptions | undefined,
  binding: ParentBinding | undefined,
): Promise<PublishedDurable> {
  const verified = await verifyAndSyncDurableTemp(tmpPath, content, options?.mode, binding);
  let published = false;
  try {
    await linkPromotedTemp(tmpPath, filePath, binding, verified.stat);
    await fsyncDirectoryChain(path.dirname(filePath), binding, options?.beforeDirectorySync);
    let hookError: unknown, destinationError: unknown;
    try { await options?.afterCommit?.(); } catch (error) { hookError = error; }
    try { await assertPublishedDestination(filePath, verified.handle, binding); } catch (error) { destinationError = error; }
    await removeCommittedTemp(tmpPath, binding, verified.stat);
    if (destinationError !== undefined) throw destinationError;
    if (hookError !== undefined) throw hookError;
    published = true;
    return verified;
  } finally {
    if (!published) await verified.handle.close().catch(() => {});
  }
}

/** Link the verified reserved temp onto its destination, dropping it on failure. */
async function linkPromotedTemp(
  tmpPath: string,
  filePath: string,
  binding: ParentBinding | undefined,
  expected: Stats,
): Promise<void> {
  try {
    await linkTempNoReplace(tmpPath, filePath);
  } catch (error) {
    await removeCommittedTemp(tmpPath, binding, expected);
    throw error;
  }
}

/**
 * Verify exact reserved-temp bytes, persist them, and hand back the still-open
 * handle so the promoted inode stays pinned through link and verification.
 */
async function verifyAndSyncDurableTemp(
  tmpPath: string,
  content: Buffer,
  mode: number | undefined,
  binding: ParentBinding | undefined,
): Promise<PublishedDurable> {
  let handle: FileHandle | undefined;
  let verified = false;
  try {
    handle = await open(tmpPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const expected = await handle.stat();
    if (!expected.isFile() || expected.nlink !== 1 || expected.size !== content.byteLength ||
        (mode !== undefined && (expected.mode & 0o777) !== mode)) throw new Error("durable temp metadata conflicts");
    await assertTempPathBound(tmpPath, binding, expected);
    if (!(await hasExactHandleBytes(handle, expected, content))) throw new Error("durable temp bytes conflict");
    await handle.sync();
    await assertTempPathBound(tmpPath, binding, expected);
    verified = true;
    return { handle, stat: expected };
  } catch (error) {
    throw new AtomicWriteCommittedCleanupError(error);
  } finally {
    if (!verified) await handle?.close().catch(() => {});
  }
}

/** Test an existing collision leaf before granting it a leaf fsync. */
function isExactCollisionCandidate(expected: Stats, content: Buffer, mode: number | undefined): boolean {
  return expected.isFile() && expected.nlink === 1 && expected.size === content.byteLength &&
    (mode === undefined || (expected.mode & 0o777) === mode);
}

/**
 * Read at most one byte beyond the expected content and reject handle metadata
 * changed after the initial fstat, including a same-inode growth race.
 */
async function hasExactHandleBytes(handle: FileHandle, expected: Stats, content: Buffer): Promise<boolean> {
  const bytes = Buffer.allocUnsafe(content.byteLength + 1);
  let total = 0;
  while (total < bytes.byteLength) {
    const read = await handle.read(bytes, total, bytes.byteLength - total, total);
    if (read.bytesRead === 0) break;
    total += read.bytesRead;
  }
  const after = await handle.stat();
  return total === content.byteLength && bytes.subarray(0, total).equals(content) &&
    hasUnchangedFileMetadata(expected, after);
}

/** Compare the file metadata that makes an opened byte observation stable. */
function hasUnchangedFileMetadata(expected: Stats, after: Stats): boolean {
  return after.isFile() && after.dev === expected.dev && after.ino === expected.ino
    && after.size === expected.size && after.mode === expected.mode
    && after.nlink === expected.nlink;
}

/** Lstat one bound path while preserving absent as the sole clean empty state. */
async function lstatBoundIfPresent(
  filePath: string,
  binding: ParentBinding | undefined,
): Promise<Stats | undefined> {
  if (binding !== undefined) await assertCurrentParent(binding);
  let result: Stats;
  try {
    result = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (binding !== undefined) await assertCurrentParent(binding);
  return result;
}
