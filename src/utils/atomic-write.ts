/**
 * @file src/utils/atomic-write.ts
 * @description Shared atomic file writer with confined-parent symlink and
 * parent-swap defenses for project writes.
 */

import { rename, mkdir, open, unlink } from "fs/promises";
import { lstat, realpath } from "./fs-metadata.js";
import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "path";
import {
  assertCurrentParent,
  fsyncDirectoryChainBeforeParentCheck,
  type ParentBinding,
} from "./atomic-write-durability.js";
import {
  assertPathNamesInode,
  assertPublishedDestination,
  assertSettledDestination,
  assertTempPathBound,
  AtomicWriteCollisionError,
  AtomicWriteCommittedCleanupError,
  durableTempPath,
  durableWritingPath,
  linkWritingAsReady,
  linkTempNoReplace,
  type PublishedDurable,
  recoverDurableTemp,
  recoverStreamedDurableTemp,
  removeCommittedTemp,
  removeCommittedTempAfterPublish,
  syncExistingCollision,
} from "./atomic-write-no-replace-durable.js";
import { confineUnderRoot, isInsideDir, safeRealpath } from "./path-confine.js";

// Reserved for Foundation Task 5 catalog/projection durability.
// fallow-ignore-next-line unused-export
export { fsyncDirectory } from "./atomic-write-durability.js";

/** Bytes of randomness in the per-write temp-file suffix (16 hex chars). */
const TEMP_SUFFIX_BYTES = 8;

/** Options for {@link atomicWrite}. */
export interface AtomicWriteOptions {
  /**
   * When provided, confine the write under this project root: the nearest
   * existing ancestor of `filePath` must realpath-resolve inside `confineRoot`
   * before any directory is created, and the opened temp must remain bound to
   * the same checked parent before bytes are written.
   */
  confineRoot?: string;
  /** Opt-in power-loss durability: fsync temp data before rename and parent after rename. */
  durable?: boolean;
  /** Fail closed on unsupported directory fsync and sync every containing directory. */
  strictDurability?: boolean;
  /** Reject in-root ancestor redirects instead of accepting any confined parent. */
  exactParent?: boolean;
  /** Optional POSIX permission bits for the created temp file. */
  mode?: number;
  /** Publish only when no destination object exists, with strict durability. */
  createOnly?: boolean;
  /** Test-only hook for deterministic parent-swap race coverage. */
  afterParentCheckForTest?: () => Promise<void>;
  /** Test-only hook for failures after a no-replace link has committed. */
  afterNoReplaceCommitForTest?: () => Promise<void>;
  /** Test-only observation/fault seam before each strict directory fsync. */
  beforeDirectorySyncForTest?: (dir: string) => Promise<void>;
  /** Test-only fault seam immediately before an existing collision leaf is synced. */
  beforeExistingFileSyncForTest?: () => Promise<void>;
  /** Test-only crash seam at each post-link boundary of a streamed CAS publish. */
  streamedPostLinkFaultForTest?: (stage: StreamedPostLinkStageV1) => Promise<void>;
}

/** The post-link boundaries a streamed CAS crash test can fault at. */
export type StreamedPostLinkStageV1 = "after-link" | "after-parent-fsync" | "after-publish-verify";

/** Shared create-only options that do not expose overwrite durability controls. */
type AtomicWriteNoReplaceSharedOptions = Pick<AtomicWriteOptions,
  "confineRoot" | "exactParent" | "mode" |
  "afterParentCheckForTest" | "afterNoReplaceCommitForTest">;

/** Candidate-oriented create-only publication has no durable-success surface. */
export type AtomicWriteNoReplaceOptions = AtomicWriteNoReplaceSharedOptions;

/** Strict create-only publication owns its one directory-sync test seam. */
export type AtomicWriteNoReplaceDurableOptions = AtomicWriteNoReplaceSharedOptions &
  Pick<AtomicWriteOptions, "beforeDirectorySyncForTest" | "beforeExistingFileSyncForTest" | "streamedPostLinkFaultForTest">;

export { AtomicWriteCollisionError, AtomicWriteCommittedCleanupError } from "./atomic-write-no-replace-durable.js";

/** Typed refusal for a dynamic caller requesting unsupported durability. */
export class AtomicWriteNoReplaceDurabilityUnsupportedError extends Error {
  constructor() {
    super("atomic no-replace durability is unsupported");
    this.name = "AtomicWriteNoReplaceDurabilityUnsupportedError";
  }
}

/** Rename succeeded, but subsequent verification or durability did not complete. */
export class AtomicWritePostCommitError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "AtomicWritePostCommitError";
  }
}

/** Snapshot mutable caller bytes before any filesystem await can yield control. */
function snapshotContent(content: string | Uint8Array): string | Buffer {
  return typeof content === "string" ? content : Buffer.from(content);
}

/**
 * Atomically write a file through a random O_EXCL temp and rename.
 * Rejection does not prove the destination is unchanged: a post-rename parent
 * or durability check can fail after publication. Callers must retain recovery
 * evidence and reconcile the destination before retrying a non-idempotent action.
 */
export async function atomicWrite(
  filePath: string,
  content: string | Uint8Array,
  opts?: AtomicWriteOptions,
): Promise<void> {
  const preparedContent = snapshotContent(content);
  if (opts?.createOnly === true) {
    await atomicWriteNoReplaceDurable(filePath, preparedContent, opts);
    return;
  }
  const { binding } = await prepareParent(filePath, opts);
  await writeViaTemp(filePath, preparedContent, opts?.durable === true, opts?.strictDurability === true, opts?.mode, binding, opts?.beforeDirectorySyncForTest);
}

/** Atomically publish a new file without replacing any destination object. */
export async function atomicWriteNoReplace(
  filePath: string,
  content: string | Uint8Array,
  opts?: AtomicWriteNoReplaceOptions,
): Promise<void> {
  assertNoReplaceOptions(opts);
  const preparedContent = snapshotContent(content);
  const { binding } = await prepareParent(filePath, opts);
  await writeViaTempNoReplace(filePath, preparedContent, opts, binding);
}

/** Atomically publish a create-only file with strict file and directory fsync. */
export async function atomicWriteNoReplaceDurable(
  filePath: string,
  content: string | Uint8Array,
  opts?: AtomicWriteNoReplaceDurableOptions,
): Promise<void> {
  const preparedContent = Buffer.from(content);
  const { dir, binding } = await prepareParent(filePath, opts);
  let published: PublishedDurable;
  try {
    published = await recoverDurableTemp(filePath, preparedContent, {
      mode: opts?.mode,
      afterCommit: opts?.afterNoReplaceCommitForTest,
      beforeDirectorySync: opts?.beforeDirectorySyncForTest,
    }, binding) ??
      await writeViaTempNoReplaceDurable(filePath, preparedContent, opts, binding);
  } catch (error) {
    if (!(error instanceof AtomicWriteCollisionError)) throw error;
    await syncExistingCollision(filePath, preparedContent, opts?.mode, binding, opts?.beforeExistingFileSyncForTest);
    await fsyncDirectoryChainBeforeParentCheck(dir, binding, opts?.beforeDirectorySyncForTest);
    if (binding !== undefined) await assertCurrentParent(binding);
    throw error;
  }
  try {
    await fsyncDirectoryChainBeforeParentCheck(dir, binding, opts?.beforeDirectorySyncForTest);
    await assertSettledDestination(filePath, published.handle, binding);
  } finally {
    await published.handle.close().catch(() => {});
  }
}

/** One durably published streamed content-addressed leaf and its byte count. */
export interface StreamedCasResultV1 {
  filename: string;
  byteCount: number;
}

/**
 * Durably publish one create-only, content-addressed leaf whose bytes are
 * streamed into a confined temp and never buffered whole in memory. The
 * destination `filename` (the caller's content digest) is known up front, so the
 * temp is a DETERMINISTIC `${filename}.tmp` rather than a random name: a crash in
 * the publish window — after the temp is linked to the digest name (leaving the
 * authoritative object at nlink=2, which the single-link evidence reader would
 * reject) and before the temp is removed — is reconciled on the next attempt by
 * {@link recoverStreamedDurableTemp} back to a clean nlink=1 object, rather than
 * permanently poisoned. The producer streams into the bound handle and returns
 * the byte count; the data is fsynced before the no-replace link, the parent is
 * fsynced, the published inode is reverified, the temp removed, the parent
 * fsynced AGAIN so the removal survives power loss (else the `.tmp` alias could
 * resurrect at nlink=2 and the single-link evidence reader would reject the
 * leaf), and the leaf confirmed as the inode's sole link. An existing leaf raises
 * {@link AtomicWriteCollisionError} for a content-addressed caller to reconcile
 * by exact re-read; a foreign hardlink is rejected, never accepted.
 *
 * SINGLE-WRITER INVARIANT: the caller MUST hold the project lock so at most one
 * writer targets a given digest at a time (the evidence store does). The
 * deterministic `${digest}.tmp` and the nlink==2 reconciliation depend on it: a
 * second concurrent writer would collide on the temp `open(..,"wx")`, and the
 * recovery's "temp is the second link of this destination" assumption holds only
 * when no other writer is mid-publish. Do NOT scope the lock narrower per digest
 * — a lost link-race under a narrower lock would turn a reconcilable crash into
 * permanent per-digest write-poison.
 */
export async function atomicStreamCreateOnlyDurable(
  destinationDir: string,
  filename: string,
  produce: (handle: FileHandle) => Promise<number>,
  opts: AtomicWriteNoReplaceDurableOptions = {},
): Promise<StreamedCasResultV1> {
  assertNoReplaceOptions(opts);
  const filePath = path.join(destinationDir, filename);
  const { dir, binding } = await prepareParent(filePath, opts);
  await recoverStreamedDurableTemp(filePath, binding, opts.beforeDirectorySyncForTest);
  const { bound, filled: byteCount } = await writeBoundTemp(durableTempPath(filePath), produce, opts.mode, binding, true);
  try {
    await commitBoundTemp(bound, binding, (scratch) => linkTempNoReplace(scratch, filePath));
    await opts.streamedPostLinkFaultForTest?.("after-link");
    await fsyncDirectoryChainBeforeParentCheck(dir, binding, opts.beforeDirectorySyncForTest);
    await opts.streamedPostLinkFaultForTest?.("after-parent-fsync");
    await assertPublishedDestination(filePath, bound.handle, binding);
    await opts.streamedPostLinkFaultForTest?.("after-publish-verify");
    await removeCommittedTemp(bound.tmpPath, binding, bound.stat);
    await fsyncDirectoryChainBeforeParentCheck(dir, binding, opts.beforeDirectorySyncForTest);
    await assertSettledDestination(filePath, bound.handle, binding);
    return { filename, byteCount };
  } finally {
    await bound.handle.close().catch(() => {});
  }
}

/** Refuse dynamically smuggled durability before any parent-directory effect. */
function assertNoReplaceOptions(opts: AtomicWriteNoReplaceOptions | undefined): void {
  const supplied = opts as AtomicWriteOptions | undefined;
  const hasStrict = supplied !== undefined && Object.hasOwn(supplied, "strictDurability");
  if (supplied?.durable === true || hasStrict) {
    throw new AtomicWriteNoReplaceDurabilityUnsupportedError();
  }
}

/** Confine, create and bind the parent shared by every publication mode. */
async function prepareParent(
  filePath: string,
  opts: AtomicWriteNoReplaceSharedOptions | undefined,
): Promise<{ dir: string; binding: ParentBinding | undefined }> {
  const dir = path.dirname(filePath);
  const realRoot = opts?.confineRoot === undefined
    ? undefined : await assertAncestorInRoot(filePath, opts.confineRoot, opts.exactParent === true);
  await mkdir(dir, { recursive: true });
  const binding = await assertParentNotSymlink(dir, opts?.confineRoot, opts?.exactParent === true, realRoot);
  await opts?.afterParentCheckForTest?.();
  return { dir, binding };
}

/** Best-effort directory fsync after a durable rename. */
async function fsyncDir(dir: string): Promise<void> {
  let dirHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    dirHandle = await open(dir, "r");
    await dirHandle.sync();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EPERM" && code !== "ENOTSUP") throw err;
  } finally {
    await dirHandle?.close().catch(() => {});
  }
}

/**
 * Fail closed before mkdir when the nearest existing ancestor escapes root.
 *
 * With `exactParent`, the canonical walk proves the nearest existing ancestor
 * of the directory resolves to its own in-root canonical path, which is the
 * ancestor confinement and more, so beyond it only the leaf is confined, and
 * the root resolved once here is returned for the parent binding to reuse.
 */
async function assertAncestorInRoot(filePath: string, confineRoot: string, exactParent: boolean): Promise<string | undefined> {
  const relPath = path.relative(confineRoot, filePath);
  const realRoot = exactParent ? await realpath(confineRoot).catch(() => undefined) : undefined;
  if (realRoot === undefined) {
    await confineUnderRoot(relPath, confineRoot, { mustExist: false });
    if (exactParent) await assertCanonicalAncestor(path.dirname(filePath), confineRoot, relPath, await realpath(confineRoot));
    return undefined;
  }
  await assertLeafInRoot(relPath, realRoot);
  await assertCanonicalAncestor(path.dirname(filePath), confineRoot, relPath, realRoot);
  return realRoot;
}

/** Confine the leaf lexically and, when it exists, by its realpath, as `confineUnderRoot` does. */
async function assertLeafInRoot(relPath: string, realRoot: string): Promise<void> {
  const leaf = path.normalize(path.resolve(realRoot, relPath));
  if (!isInsideDir(leaf, realRoot)) throw new Error(`path escapes project root: ${relPath}`);
  const realLeaf = await safeRealpath(leaf);
  if (realLeaf !== null && !isInsideDir(realLeaf, realRoot)) throw new Error(`path escapes project root: ${relPath}`);
}

/**
 * Reject even in-root symlink redirects before recursive mkdir can follow
 * them, naming an out-of-root ancestor as the escape `confineUnderRoot` would.
 */
async function assertCanonicalAncestor(dir: string, confineRoot: string, relPath: string, realRoot: string): Promise<void> {
  const lexicalRoot = path.resolve(confineRoot);
  let current = path.resolve(dir);
  for (;;) {
    try {
      const actual = await realpath(current);
      if (!isInsideDir(actual, realRoot)) throw new Error(`path escapes project root: ${relPath}`);
      const expected = path.join(realRoot, path.relative(lexicalRoot, current));
      if (actual !== expected) throw new Error(`write directory redirects from its canonical project path: ${current}`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error("write directory has no canonical project ancestor");
    current = parent;
  }
}

/**
 * Reject a symlinked parent and capture its identity for later binding checks,
 * against `knownRealRoot` when the pre-mkdir confinement already resolved it.
 */
async function assertParentNotSymlink(
  dir: string, confineRoot?: string, exactParent = false, knownRealRoot?: string,
): Promise<ParentBinding | undefined> {
  const dirStat = await lstat(dir);
  if (dirStat.isSymbolicLink()) {
    throw new Error(`refusing to write through a symlinked directory: ${dir}`);
  }
  if (confineRoot === undefined) return undefined;
  const realRoot = knownRealRoot ?? await realpath(confineRoot);
  const realDir = await realpath(dir);
  if (!isInsideDir(realDir, realRoot)) {
    throw new Error(`write directory escapes project root: ${dir}`);
  }
  const expected = path.join(realRoot, path.relative(path.resolve(confineRoot), path.resolve(dir)));
  if (exactParent && realDir !== expected) throw new Error(`write directory redirects from its canonical project path: ${dir}`);
  return { dir, lexicalRoot: path.resolve(confineRoot), realRoot, realDir, dev: dirStat.dev, ino: dirStat.ino };
}

/** Write content only after the opened temp handle is bound to the checked parent. */
async function writeViaTemp(
  filePath: string,
  content: string | Uint8Array,
  durable: boolean,
  strictDurability: boolean,
  mode?: number,
  binding?: ParentBinding,
  beforeDirectorySync?: (dir: string) => Promise<void>,
): Promise<void> {
  const { bound: temp } = await writeBoundTemp(
    randomTempPath(filePath), (handle) => handle.writeFile(content), mode, binding, durable || strictDurability);
  let renamed = false;
  try {
    await commitBoundTemp(temp, binding, (tmpPath) => rename(tmpPath, filePath));
    renamed = true;
    // A directory sync changes no name, so the one check after it covers the
    // rename as well; a check between the two would only repeat it.
    if (strictDurability) await fsyncDirectoryChainBeforeParentCheck(path.dirname(filePath), binding, beforeDirectorySync);
    else if (durable) await fsyncDir(path.dirname(filePath));
    await assertCommittedTemp(filePath, temp.handle, binding, strictDurability);
  } catch (error) {
    if (renamed) throw new AtomicWritePostCommitError(error);
    throw error;
  } finally {
    await temp.handle.close().catch(() => {});
  }
}

/** Recheck the committed destination at the caller's requested assurance level. */
async function assertCommittedTemp(
  filePath: string, handle: FileHandle, binding: ParentBinding | undefined, strict: boolean,
): Promise<void> {
  if (strict) await assertPublishedDestination(filePath, handle, binding);
  else if (binding !== undefined) await assertCurrentParent(binding);
}

/** Link a synced same-directory temp, leaving collision or fsync faults visible. */
async function writeViaTempNoReplaceDurable(
  filePath: string,
  content: string | Uint8Array,
  opts: AtomicWriteNoReplaceDurableOptions | undefined,
  binding: ParentBinding | undefined,
): Promise<PublishedDurable> {
  const writingPath = durableWritingPath(filePath);
  const readyPath = durableTempPath(filePath);
  const { bound: prepared } = await writeBoundTemp(writingPath, (handle) => handle.writeFile(content), opts?.mode, binding, true);
  try {
    await commitBoundTemp(prepared, binding, (scratch) => linkWritingAsReady(scratch, readyPath));
    await fsyncDirectoryChainBeforeParentCheck(path.dirname(filePath), binding, opts?.beforeDirectorySyncForTest);
    await removeCommittedTemp(writingPath, binding, prepared.stat);
    const promoted = await recoverDurableTemp(filePath, Buffer.from(content), {
      mode: opts?.mode,
      afterCommit: opts?.afterNoReplaceCommitForTest,
      beforeDirectorySync: opts?.beforeDirectorySyncForTest,
    }, binding);
    if (promoted === undefined) throw new AtomicWriteCommittedCleanupError(new Error("durable ready alias disappeared"));
    return promoted;
  } finally {
    await prepared.handle.close().catch(() => {});
  }
}

/** Write and link a random same-directory temp, keeping its handle open to pin the inode. */
async function linkViaTemp(
  filePath: string,
  content: string | Uint8Array,
  mode: number | undefined,
  binding: ParentBinding | undefined,
  afterCommit: (() => Promise<void>) | undefined,
): Promise<LinkedTemp> {
  const { bound: temp } = await writeBoundTemp(randomTempPath(filePath), (handle) => handle.writeFile(content), mode, binding, false);
  let published = false;
  try {
    await commitBoundTemp(temp, binding, (committedPath) => linkTempNoReplace(committedPath, filePath));
    // The link is the commit point: a later hook fault cannot undo it.
    await afterCommit?.().catch(() => {});
    let destinationError: unknown;
    try { await assertPublishedDestination(filePath, temp.handle, binding); } catch (error) { destinationError = error; }
    await removeCommittedTempAfterPublish(temp.tmpPath, binding, temp.stat, destinationError === undefined);
    if (destinationError !== undefined) throw destinationError;
    published = true;
    return { handle: temp.handle, stat: temp.stat };
  } finally {
    if (!published) await temp.handle.close().catch(() => {});
  }
}

/** Prepared temp identity retained across publication while its handle stays open. */
interface BoundTemp { tmpPath: string; handle: FileHandle; stat: Stats }
/** Published destination handle, held open to pin the inode. */
interface LinkedTemp { handle: FileHandle; stat: Stats }

/** A random, per-write temp path beside `filePath`. */
function randomTempPath(filePath: string): string {
  return `${filePath}.${randomBytes(TEMP_SUFFIX_BYTES).toString("hex")}.tmp`;
}

/**
 * Create `tmpPath` exclusively, fill it and optionally sync it while its
 * handle remains parent-bound; `filled` is what `fill` returned. The temp is
 * checked once after it is created, before any bytes go in. Every caller
 * passes the result straight to {@link commitBoundTemp}, which checks the
 * parent and path again right before publishing, so no check runs between the
 * write and that one. On failure the temp is closed and removed.
 */
async function writeBoundTemp<T>(
  tmpPath: string, fill: (handle: FileHandle) => Promise<T>,
  mode: number | undefined, binding: ParentBinding | undefined, durable: boolean,
): Promise<{ bound: BoundTemp; filled: T }> {
  const handle = mode === undefined ? await open(tmpPath, "wx") : await open(tmpPath, "wx", mode);
  try {
    await assertTempHandleBound(handle, tmpPath, binding);
    const filled = await fill(handle);
    if (durable) await handle.sync();
    return { bound: { tmpPath, handle, stat: await handle.stat() }, filled };
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

/** Rebind and publish a prepared temp, holding its handle open to pin the inode. */
async function commitBoundTemp(temp: BoundTemp, binding: ParentBinding | undefined, commit: (tmpPath: string) => Promise<void>): Promise<void> {
  try {
    await assertTempPathBound(temp.tmpPath, binding, temp.stat);
    await commit(temp.tmpPath);
  } catch (error) {
    await temp.handle.close().catch(() => {});
    await unlink(temp.tmpPath).catch(() => {});
    throw error;
  }
}

/** Link one completed same-directory temp as the no-replace commit point. */
async function writeViaTempNoReplace(
  filePath: string,
  content: string | Uint8Array,
  opts: AtomicWriteNoReplaceOptions | undefined,
  binding: ParentBinding | undefined,
): Promise<void> {
  const linked = await linkViaTemp(filePath, content, opts?.mode, binding, opts?.afterNoReplaceCommitForTest);
  try {
    await assertPublishedDestination(filePath, linked.handle, binding);
  } finally {
    await linked.handle.close().catch(() => {});
  }
}

/**
 * Verify the parent, then that the open temp handle and temp path resolve to
 * the same file. Only an fstat separates the parent check from the path
 * check, so the path check does not repeat it.
 */
async function assertTempHandleBound(
  handle: FileHandle,
  tmpPath: string,
  binding: ParentBinding | undefined,
): Promise<void> {
  if (binding !== undefined) await assertCurrentParent(binding);
  await assertPathNamesInode(tmpPath, await handle.stat());
}
