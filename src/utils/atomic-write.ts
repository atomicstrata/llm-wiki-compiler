/**
 * @file src/utils/atomic-write.ts
 * @description Shared atomic file writer with confined-parent symlink and
 * parent-swap defenses for project writes.
 */

import { rename, mkdir, open, unlink } from "fs/promises";
import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "path";
import {
  assertCurrentParent,
  fsyncDirectoryChain,
  requireScopedParent,
  type ParentBinding,
} from "./atomic-write-durability.js";
import {
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
  syncExistingCollision,
} from "./atomic-write-no-replace-durable.js";
import { assertAncestorInRoot, assertParentNotSymlink, bindStreamDestination, prepareNoReplace } from "./atomic-write-parent.js";
import type { DirectorySyncScope } from "./directory-sync-scope.js";

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
  /**
   * Opt-in (create-only only): one locked batch's memo of already durable
   * ancestor directories, so their fsyncs are not repeated. Every file sync and
   * leaf-parent sync still runs. Refused for any other write mode.
   */
  directorySyncScope?: DirectorySyncScope;
  /** Test-only hook for deterministic parent-swap race coverage. */
  afterParentCheckForTest?: () => Promise<void>;
  /**
   * Final revalidation of a replacing write: called once the temp is written
   * (and synced when durable), IMMEDIATELY before the temp is re-bound to the
   * checked parent and renamed over the destination. A rejection publishes
   * nothing. This is the last check before publication, not an atomic
   * compare-and-swap against writers that ignore it.
   */
  beforeReplace?: () => Promise<void>;
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

/** Buffered strict create-only publication may additionally share a batch directory-sync scope. */
export type AtomicWriteNoReplaceDurableScopedOptions = AtomicWriteNoReplaceDurableOptions &
  Pick<AtomicWriteOptions, "directorySyncScope">;

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
  if (opts?.directorySyncScope !== undefined && opts.createOnly !== true) {
    throw new Error("a directory sync scope is only supported for create-only writes");
  }
  if (opts?.createOnly === true) {
    await atomicWriteNoReplaceDurable(filePath, preparedContent, opts);
    return;
  }
  await atomicWriteStreamed(filePath, preparedContent, opts);
}

/**
 * The replacing write of {@link atomicWrite} (never create-only), whose
 * content may also be PRODUCED into the bound temp's handle by a function, so
 * a large file is never held whole: the same ancestor guard, parent binding,
 * temp-handle binding, rebinding before the rename and post-commit checks. A
 * producer that rejects removes the temp and leaves the destination untouched.
 */
export async function atomicWriteStreamed(filePath: string, content: TempContent, opts?: Omit<AtomicWriteOptions, "createOnly">): Promise<void> {
  const o: AtomicWriteOptions = opts ?? {};
  const dir = path.dirname(filePath);
  if (o.confineRoot !== undefined) await assertAncestorInRoot(filePath, o.confineRoot, o.exactParent === true);
  await mkdir(dir, { recursive: true });
  const binding = await assertParentNotSymlink(dir, o.confineRoot, o.exactParent === true);
  await o.afterParentCheckForTest?.();
  await writeViaTemp(filePath, content, o.durable === true, o.strictDurability === true, o.mode, binding, o);
}

/** Atomically publish a new file without replacing any destination object. */
export async function atomicWriteNoReplace(
  filePath: string,
  content: string | Uint8Array,
  opts?: AtomicWriteNoReplaceOptions,
): Promise<void> {
  assertNoReplaceOptions(opts);
  const preparedContent = snapshotContent(content);
  const { binding } = await prepareNoReplace(filePath, opts);
  await writeViaTempNoReplace(filePath, preparedContent, opts, binding);
}

/** Atomically publish a create-only file with strict file and directory fsync. */
export async function atomicWriteNoReplaceDurable(
  filePath: string,
  content: string | Uint8Array,
  opts?: AtomicWriteNoReplaceDurableScopedOptions,
): Promise<void> {
  const preparedContent = Buffer.from(content);
  const { dir, binding } = await prepareNoReplace(filePath, opts);
  const scope = opts?.directorySyncScope;
  // Bind the scope before any temp exists, so a retired/foreign scope has no effect.
  if (scope !== undefined) requireScopedParent(binding, scope);
  let published: PublishedDurable;
  try {
    published = await recoverDurableTemp(filePath, preparedContent, {
      mode: opts?.mode,
      afterCommit: opts?.afterNoReplaceCommitForTest,
      beforeDirectorySync: opts?.beforeDirectorySyncForTest,
      directorySyncScope: scope,
    }, binding) ??
      await writeViaTempNoReplaceDurable(filePath, preparedContent, opts, binding);
  } catch (error) {
    if (!(error instanceof AtomicWriteCollisionError)) throw error;
    await syncExistingCollision(filePath, preparedContent, opts?.mode, binding, opts?.beforeExistingFileSyncForTest);
    await fsyncDirectoryChain(dir, binding, opts?.beforeDirectorySyncForTest, scope);
    if (binding !== undefined) await assertCurrentParent(binding);
    throw error;
  }
  try {
    await fsyncDirectoryChain(dir, binding, opts?.beforeDirectorySyncForTest, scope);
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
  const binding = await bindStreamDestination(destinationDir, opts);
  if (opts.confineRoot !== undefined) await assertAncestorInRoot(filePath, opts.confineRoot, opts.exactParent === true);
  await recoverStreamedDurableTemp(filePath, binding, opts.beforeDirectorySyncForTest);
  const temp = await writeStreamedBoundTemp(durableTempPath(filePath), produce, opts.mode, binding);
  try {
    await commitBoundTemp(temp.bound, binding, (scratch) => linkTempNoReplace(scratch, filePath));
    await opts.streamedPostLinkFaultForTest?.("after-link");
    await fsyncDirectoryChain(destinationDir, binding, opts.beforeDirectorySyncForTest);
    await opts.streamedPostLinkFaultForTest?.("after-parent-fsync");
    await assertPublishedDestination(filePath, temp.bound.handle, binding);
    await opts.streamedPostLinkFaultForTest?.("after-publish-verify");
    await removeCommittedTemp(temp.bound.tmpPath, binding, temp.bound.stat);
    await fsyncDirectoryChain(destinationDir, binding, opts.beforeDirectorySyncForTest);
    await assertSettledDestination(filePath, temp.bound.handle, binding);
    return { filename, byteCount: temp.byteCount };
  } finally {
    await temp.bound.handle.close().catch(() => {});
  }
}

/** Open the confined deterministic temp, stream the producer's bytes in, and fsync. */
async function writeStreamedBoundTemp(
  tmpPath: string,
  produce: (handle: FileHandle) => Promise<number>,
  mode: number | undefined,
  binding: ParentBinding | undefined,
): Promise<{ bound: BoundTemp; byteCount: number }> {
  const handle = mode === undefined ? await open(tmpPath, "wx") : await open(tmpPath, "wx", mode);
  try {
    await assertTempHandleBound(handle, tmpPath, binding);
    const byteCount = await produce(handle);
    await handle.sync();
    const stat = await assertTempHandleBound(handle, tmpPath, binding);
    return { bound: { tmpPath, handle, stat }, byteCount };
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(tmpPath).catch(() => {});
    throw error;
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

/** A temp's content: bytes, or a producer that writes them into the bound handle. */
export type TempContent = string | Uint8Array | ((handle: FileHandle) => Promise<void>);

/** Write content only after the opened temp handle is bound to the checked parent. */
async function writeViaTemp(
  filePath: string,
  content: TempContent,
  durable: boolean,
  strictDurability: boolean,
  mode: number | undefined,
  binding: ParentBinding | undefined,
  hooks: Pick<AtomicWriteOptions, "beforeDirectorySyncForTest" | "beforeReplace">,
): Promise<void> {
  const temp = await writeBoundTemp(filePath, content, mode, binding, durable || strictDurability);
  let renamed = false;
  try {
    await commitBoundTemp(temp, binding, (tmpPath) => rename(tmpPath, filePath), hooks.beforeReplace);
    renamed = true;
    await assertCommittedTemp(filePath, temp.handle, binding, strictDurability);
    if (strictDurability) await fsyncDirectoryChain(path.dirname(filePath), binding, hooks.beforeDirectorySyncForTest);
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
  opts: AtomicWriteNoReplaceDurableScopedOptions | undefined,
  binding: ParentBinding | undefined,
): Promise<PublishedDurable> {
  const writingPath = durableWritingPath(filePath);
  const readyPath = durableTempPath(filePath);
  const prepared = await writeBoundTemp(filePath, content, opts?.mode, binding, true, writingPath);
  try {
    await commitBoundTemp(prepared, binding, (scratch) => linkWritingAsReady(scratch, readyPath, binding, prepared.stat));
    await fsyncDirectoryChain(path.dirname(filePath), binding, opts?.beforeDirectorySyncForTest, opts?.directorySyncScope);
    await removeCommittedTemp(writingPath, binding, prepared.stat);
    const promoted = await recoverDurableTemp(filePath, Buffer.from(content), {
      mode: opts?.mode,
      afterCommit: opts?.afterNoReplaceCommitForTest,
      beforeDirectorySync: opts?.beforeDirectorySyncForTest,
      directorySyncScope: opts?.directorySyncScope,
    }, binding);
    if (promoted === undefined) throw new AtomicWriteCommittedCleanupError(new Error("durable ready alias disappeared"));
    return promoted;
  } finally {
    await prepared.handle.close().catch(() => {});
  }
}

/** Write and link a same-directory temp, keeping its handle open to pin the inode. */
async function linkViaTemp(
  filePath: string,
  content: string | Uint8Array,
  mode: number | undefined,
  binding: ParentBinding | undefined,
  durable: boolean,
  afterCommit: (() => Promise<void>) | undefined,
  tmpPath?: string,
): Promise<LinkedTemp> {
  const temp = await writeBoundTemp(filePath, content, mode, binding, durable, tmpPath);
  let published = false;
  try {
    await commitBoundTemp(temp, binding, (committedPath) => linkTempNoReplace(committedPath, filePath));
    let hookError: unknown, destinationError: unknown;
    try { await afterCommit?.(); } catch (error) { hookError = error; }
    try { await assertPublishedDestination(filePath, temp.handle, binding); } catch (error) { destinationError = error; }
    await removeCommittedTemp(temp.tmpPath, binding, temp.stat);
    if (destinationError !== undefined) throw destinationError;
    published = true;
    return { handle: temp.handle, stat: temp.stat, hookError };
  } finally {
    if (!published) await temp.handle.close().catch(() => {});
  }
}

/** Prepared temp identity retained across publication while its handle stays open. */
interface BoundTemp { tmpPath: string; handle: FileHandle; stat: Stats }
/** Published destination handle plus any test-hook fault retained after cleanup. */
interface LinkedTemp { handle: FileHandle; stat: Stats; hookError?: unknown }

/** Write and optionally sync one temp while its handle remains parent-bound. */
async function writeBoundTemp(filePath: string, content: TempContent, mode: number | undefined, binding: ParentBinding | undefined, durable: boolean, preparedPath?: string): Promise<BoundTemp> {
  const tmpPath = preparedPath ?? `${filePath}.${randomBytes(TEMP_SUFFIX_BYTES).toString("hex")}.tmp`;
  const handle = mode === undefined ? await open(tmpPath, "wx") : await open(tmpPath, "wx", mode);
  try {
    await assertTempHandleBound(handle, tmpPath, binding);
    await (typeof content === "function" ? content(handle) : handle.writeFile(content));
    if (durable) await handle.sync();
    return { tmpPath, handle, stat: await assertTempHandleBound(handle, tmpPath, binding) };
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

/** Run the caller's final check, then rebind and publish a prepared temp, holding its handle open to pin the inode. */
async function commitBoundTemp(temp: BoundTemp, binding: ParentBinding | undefined, commit: (tmpPath: string) => Promise<void>, beforeCommit?: () => Promise<void>): Promise<void> {
  try {
    await beforeCommit?.();
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
  const linked = await linkViaTemp(filePath, content, opts?.mode, binding, false, opts?.afterNoReplaceCommitForTest);
  try {
    await assertPublishedDestination(filePath, linked.handle, binding);
  } finally {
    await linked.handle.close().catch(() => {});
  }
}

/** Verify the open temp handle and temp path resolve to the same file. */
async function assertTempHandleBound(
  handle: FileHandle,
  tmpPath: string,
  binding: ParentBinding | undefined,
): Promise<Stats> {
  if (binding !== undefined) await assertCurrentParent(binding);
  const handleStat = await handle.stat();
  await assertTempPathBound(tmpPath, binding, handleStat);
  return handleStat;
}
