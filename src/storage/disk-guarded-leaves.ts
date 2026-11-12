/**
 * @file src/storage/disk-guarded-leaves.ts
 * @description The guarded PHYSICAL operations on a local project's record
 * directories and leaves: is a bound directory still the same object, can it
 * be listed or written, what are a leaf's exact bytes and identity, which
 * suffixed entries does a bound directory hold, and move one leaf while
 * holding it open. The review-candidate custody code is its first caller, and
 * these bodies are that code, moved here.
 *
 * This is a LOCAL PHYSICAL IMPLEMENTATION BOUNDARY, not a port and not a
 * workflow layer. There is one implementation and nothing is injected.
 * Identity is a device and inode number, so none of this can run against a
 * remote backend, and it is not a step toward hosting the legacy queue. A
 * registered or hosted project uses `ProjectStore`
 * (`src/portable/store/store.ts`), which proves a version by a revision token;
 * that is a different contract and stays separate.
 *
 * WHAT EACH FUNCTION GUARANTEES. Three classes; a function's own comment says
 * which it is in and lists its checks in order.
 *
 *  1. CARRIES ITS PHYSICAL GUARD: {@link directoryStillBound},
 *     {@link probeDirectory}, {@link readGuardedLeaf},
 *     {@link enumerateSuffixedNames}, {@link moveGuardedLeaf}. Also
 *     {@link readConfinedLeafText} and {@link readConfinedLeafBytes}, whose
 *     guard is the incumbent confined read's and NOT {@link readGuardedLeaf}'s:
 *     the root is taken as given, the expected parent is the caller's, and no
 *     identity is returned. And {@link readLeafTextNoFollow}, whose check is
 *     on the LEAF ONLY (no link followed, regular file), with no confinement.
 *  2. CARRIES ONLY AN EXISTING WRITER'S PROPERTY: {@link createLeafNoReplace}
 *     (never replaces an existing destination; confined to the project) and
 *     {@link replaceLeafAtomic} (a reader sees the old or the new content;
 *     confined to the project). Neither knows WHICH object it is replacing,
 *     whether a twin exists elsewhere, or whether the caller observed anything.
 *     Neither is made durable against power loss.
 *     {@link writeLeafAtomicUnconfined} is in this class too and is NARROWER:
 *     the same atomic replacement, but NOT CONFINED to any project. It is safe
 *     only on a path its caller has already confined.
 *     {@link replaceLeafAtomicWithin} is confined to the root form its CALLER
 *     gives; nothing is resolved here.
 *  3. CARRIES NO GUARD: {@link ensureDirectory}, {@link leafPresent},
 *     {@link removeLeaf}, {@link makeDirectoryTree},
 *     {@link renameLeafUnguarded}, {@link listDirectoryNames} and
 *     {@link listDirectoryEntries}. One system call each. Those that change
 *     the disk are safe only as a step of a caller that makes its own
 *     observations around them; there is no receipt check in them.
 *     {@link listDirectoryEntries} returns Node's `Dirent` objects, which are
 *     a LOCAL DISK type and not a store contract: a registered or hosted
 *     project has no such value.
 *
 * {@link sameIdentity}, {@link leafDigest} and {@link leafMatches} are pure.
 *
 * None of these functions knows what a candidate, a receipt, a byte policy or
 * a typed custody error is: refusals are values or raw errors, and the caller
 * decides what each means. The one exception is {@link readLeafTextNoFollow},
 * which deliberately returns `null` for every open and read failure.
 *
 * WHAT THIS MODULE DOES NOT GUARANTEE. The guarded move renames BY PATH after
 * its last check; pure Node has no handle-relative or no-replace rename, so a
 * path swapped in that window is renamed, and a destination that appears in it
 * is replaced. {@link replaceLeafAtomic} and {@link removeLeaf} act by path:
 * a leaf swapped in after the caller's last observation is the one replaced or
 * removed. {@link createLeafNoReplace} cannot see an object that appears in
 * another directory after the caller's hook ran. An enumeration is a snapshot.
 * Nothing in this module prevents a caller from composing a weaker sequence
 * out of its parts, such as a read, a create elsewhere and a removal, which
 * is a copy-and-unlink; it only contains no such sequence itself, and the
 * custody code composes none. {@link renameLeafUnguarded} and
 * {@link writeLeafAtomicUnconfined} are unguarded BY DESIGN and must not be
 * used where custody or confinement is required.
 */

import { createHash } from "node:crypto";
import { constants, type Dir, type Dirent } from "node:fs";
import { access, lstat, mkdir, opendir, readdir, realpath, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, atomicWriteNoReplace } from "../utils/atomic-write.js";
import {
  openConfinedLeaf, readConfinedLeaf, readConfinedLeafBuffer,
  type CappedLeafRead, type CappedLeafReadBuffer, type ConfirmedLeafOpen, type ReadLeafOptions,
} from "../utils/confined-read.js";
import { openFileNoFollow } from "../utils/no-follow-open.js";
import {
  captureCandidateDirectoryBinding,
  type CandidateDirectoryBinding,
  type CandidateDirectoryIdentity,
} from "./disk-record-directory.js";

/** A guarded leaf read's outcome. Refusals are values, never typed errors. */
export type GuardedLeafRead =
  | { kind: "absent" }
  | { kind: "unavailable" }
  | { kind: "ok"; bytes: Buffer; fileIdentity: CandidateDirectoryIdentity };

/** One guarded leaf read: where the leaf is, which bound directories must still hold, and the byte cap. */
export interface GuardedLeafReadRequest {
  readonly root: string;
  readonly leaf: string;
  readonly store: CandidateDirectoryBinding;
  readonly location: CandidateDirectoryBinding;
  readonly maxBytes: number;
}

/** What a leaf's bytes and identity must be. A custody receipt structurally supplies it. */
export interface GuardedLeafExpectation {
  readonly byteCount: number;
  readonly sha256: string;
  readonly fileIdentity: CandidateDirectoryIdentity;
}

/** One guarded move: the two paths, the bound parents, what the source must still be, and the post-rename check. */
export interface GuardedLeafMoveRequest {
  readonly root: string;
  readonly source: string;
  readonly destination: string;
  readonly maxBytes: number;
  readonly parents: { readonly source: CandidateDirectoryBinding; readonly destination: CandidateDirectoryBinding };
  readonly expect: GuardedLeafExpectation;
  /** REQUIRED. Runs after the rename while the source handle is still open; its result is the move's result. */
  readonly afterRename: () => Promise<boolean>;
}

/** One create-only leaf write: where, what, and the two points at which the caller's hooks run. */
export interface LeafCreateRequest {
  readonly root: string;
  readonly leaf: string;
  readonly text: string;
  /** Runs after the writer has checked the parent directory and before it commits. Rejects to abort. */
  readonly afterParentCheck: () => Promise<void>;
  /** Runs after the leaf has been committed. */
  readonly afterCommit?: () => Promise<void>;
}

/** Caps, checkpoints and hooks for one strict enumeration of a bound directory. */
export interface SuffixedNameEnumeration {
  /** Entries whose name ends with this are named. Must not be empty. */
  readonly suffix: string;
  readonly maxDirectEntries: number;
  readonly maxNames: number;
  /** Runs before the open, after the open, and after the stream. Rejects to abort. */
  readonly recheck: () => Promise<void>;
  /** The error to throw when a cap is exceeded, before the excess entry is kept. */
  readonly overflow: () => Error;
  readonly beforeOpen?: () => Promise<void>;
  readonly afterOpen?: () => Promise<void>;
}

/** Compare stable filesystem identities without coercion. Pure. */
export function sameIdentity(left: CandidateDirectoryIdentity, right: CandidateDirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Hash exact raw bytes. Pure. The one digest used for expectations and receipts. */
export function leafDigest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The one rule for "this read is the expected leaf": an `ok` read with the
 * same byte count, the same identity and the same digest. Pure.
 */
export function leafMatches(read: GuardedLeafRead, expect: GuardedLeafExpectation): boolean {
  return read.kind === "ok" && read.bytes.byteLength === expect.byteCount &&
    sameIdentity(read.fileIdentity, expect.fileIdentity) &&
    leafDigest(read.bytes) === expect.sha256;
}

/**
 * NO GUARD. `mkdir(join(root, relDir))`, not recursive, with every error
 * ignored: an existing directory, a missing parent and a refusal all look the
 * same to the caller, which must bind the directory afterward to learn
 * anything. It confines nothing and checks nothing.
 */
export async function ensureDirectory(root: string, relDir: string): Promise<void> {
  await mkdir(path.join(root, relDir)).catch(() => {});
}

/**
 * Re-prove that a captured directory still names the same canonical inode: it
 * is captured again from the root, and must resolve to the same real path and
 * identity. Any failure, including a thrown one, is `false`.
 */
export async function directoryStillBound(root: string, binding: CandidateDirectoryBinding): Promise<boolean> {
  try {
    const relative = path.relative(path.resolve(root), path.resolve(binding.dir));
    const current = await captureCandidateDirectoryBinding(root, relative);
    return current !== null && current.realDir === binding.realDir &&
      sameIdentity(current.identity, binding.identity);
  } catch {
    return false;
  }
}

/**
 * Prove effective access to one bound directory and re-bind it afterward.
 *
 *  - `"write"`: `access` for write and search, then still bound.
 *  - `"list"`: `access` for read and search, then still bound, then open the
 *    directory, close it, and still bound AGAIN.
 *
 * `true` only if every step succeeds. Any failure, including a thrown error,
 * is `false`, and a directory that was opened is closed, best effort, on every
 * path.
 */
export async function probeDirectory(
  root: string,
  binding: CandidateDirectoryBinding,
  need: "list" | "write",
): Promise<boolean> {
  let directory: Dir | undefined;
  try {
    const mode = need === "list" ? constants.R_OK | constants.X_OK : constants.W_OK | constants.X_OK;
    await access(binding.realDir, mode);
    if (!(await directoryStillBound(root, binding))) return false;
    if (need === "write") return true;
    directory = await opendir(binding.realDir);
    await directory.close();
    directory = undefined;
    return await directoryStillBound(root, binding);
  } catch {
    await directory?.close().catch(() => {});
    return false;
  }
}

/** Read exactly the initial bounded handle size without following a growing EOF. */
async function readExactHandle(handle: FileHandle, size: number): Promise<Buffer | null> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = await handle.read(bytes, offset, size - offset, offset);
    if (read.bytesRead === 0) return null;
    offset += read.bytesRead;
  }
  const after = await handle.stat();
  return after.isFile() && after.size === size ? bytes : null;
}

/** Require the opened handle to remain the exact file at its confined leaf. */
async function handleStillBound(
  handle: FileHandle,
  leaf: string,
  fileIdentity: CandidateDirectoryIdentity,
): Promise<boolean> {
  const [opened, current] = await Promise.all([handle.stat(), lstat(leaf)]);
  return opened.isFile() && sameIdentity(opened, fileIdentity) &&
    sameIdentity(current, fileIdentity);
}

/** Read and rebind one already confinement-proved leaf handle; the handle is always closed. */
async function consumeConfirmedLeaf(
  request: GuardedLeafReadRequest,
  opened: ConfirmedLeafOpen,
): Promise<GuardedLeafRead> {
  try {
    const info = await opened.handle.stat();
    const identity = { dev: info.dev, ino: info.ino };
    const bytes = await readExactHandle(opened.handle, opened.size);
    const leafBound = await handleStillBound(opened.handle, request.leaf, identity).catch(() => false);
    const parentsBound = await directoryStillBound(request.root, request.store) &&
      await directoryStillBound(request.root, request.location);
    return bytes && leafBound && parentsBound
      ? { kind: "ok", bytes, fileIdentity: identity }
      : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/**
 * Open and read one leaf through the root-anchored no-follow seam, proving the
 * bytes are the opened object's and that nothing was swapped meanwhile:
 *
 *  1. resolve the root. This is OUTSIDE every `try`: a root that cannot be
 *     resolved REJECTS with the raw error;
 *  2. open the leaf confined to `location` without following a link; a result
 *     other than a confirmed handle is returned as it is;
 *  3. refuse a leaf larger than `maxBytes`;
 *  4. read exactly the opened size from the held handle, then require the
 *     handle to be the same regular file of that size, the handle and the path
 *     to be the same inode, and `store` and `location` to be still bound.
 *
 * Every refusal in steps 2 to 4 is a value. Only step 1 rejects.
 */
export async function readGuardedLeaf(request: GuardedLeafReadRequest): Promise<GuardedLeafRead> {
  const opened = await openConfinedLeaf(await realpath(request.root), request.leaf, request.location.realDir);
  if (opened.kind !== "confirmed") return opened;
  if (opened.size > request.maxBytes) {
    await opened.handle.close().catch(() => {});
    return { kind: "unavailable" };
  }
  return consumeConfirmedLeaf(request, opened);
}

/**
 * Stream a bound directory and name its suffixed entries, in this order:
 * `beforeOpen` hook, `recheck`, open, `afterOpen` hook, `recheck`, the capped
 * stream, `recheck`, and close in a `finally`.
 *
 * An entry of ANY kind whose name ends with the suffix is named, with the
 * suffix removed; no regular-file filter is applied. Both caps are checked
 * before the entry is kept. Names come back in stream order, unsorted.
 *
 * Nothing is caught here: a hook, a `recheck`, the open, the stream or
 * `overflow()` propagates to the caller, after the directory is closed.
 *
 * @throws RangeError before any hook or I/O when the suffix is empty, because
 *   removing an empty suffix would name every entry as the empty string.
 */
export async function enumerateSuffixedNames(
  binding: CandidateDirectoryBinding,
  enumeration: SuffixedNameEnumeration,
): Promise<string[]> {
  if (enumeration.suffix.length === 0) throw new RangeError("enumeration suffix must not be empty");
  const names: string[] = [];
  let directEntries = 0;
  let directory: Dir | undefined;
  try {
    await enumeration.beforeOpen?.();
    await enumeration.recheck();
    directory = await opendir(binding.realDir);
    await enumeration.afterOpen?.();
    await enumeration.recheck();
    for await (const entry of directory) {
      directEntries += 1;
      if (directEntries > enumeration.maxDirectEntries) throw enumeration.overflow();
      if (!entry.name.endsWith(enumeration.suffix)) continue;
      if (names.length >= enumeration.maxNames) throw enumeration.overflow();
      names.push(entry.name.slice(0, -enumeration.suffix.length));
    }
    await enumeration.recheck();
  } finally {
    await directory?.close().catch(() => {});
  }
  return names;
}

/** Require an exact expectation-bound source while retaining its open handle; `null` on any refusal. */
async function openMoveSource(request: GuardedLeafMoveRequest): Promise<FileHandle | null> {
  const opened = await openConfinedLeaf(await realpath(request.root), request.source, request.parents.source.realDir);
  if (opened.kind !== "confirmed") return null;
  if (opened.size > request.maxBytes) {
    await opened.handle.close().catch(() => {});
    return null;
  }
  let accepted = false;
  try {
    const info = await opened.handle.stat();
    const identity = { dev: info.dev, ino: info.ino };
    const bytes = await readExactHandle(opened.handle, opened.size);
    const read: GuardedLeafRead = bytes
      ? { kind: "ok", bytes, fileIdentity: identity }
      : { kind: "unavailable" };
    if (!leafMatches(read, request.expect)) return null;
    if (!(await handleStillBound(opened.handle, request.source, identity))) return null;
    accepted = true;
    return opened.handle;
  } catch {
    return null;
  } finally {
    if (!accepted) await opened.handle.close().catch(() => {});
  }
}

/** True only when a destination leaf is currently absent. */
async function destinationIsAbsent(destination: string): Promise<boolean> {
  try {
    await lstat(destination);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** Recheck both parent bindings immediately before the path-based rename. */
async function parentsStillBound(
  root: string,
  parents: GuardedLeafMoveRequest["parents"],
): Promise<boolean> {
  return (await directoryStillBound(root, parents.source)) &&
    (await directoryStillBound(root, parents.destination));
}

/**
 * Rename one leaf while holding it open, only if it is still the expected
 * object, in this order:
 *
 *  1. open the source confined to its parent without following a link, refuse
 *     it over `maxBytes`, read exactly its opened size from the handle, require
 *     {@link leafMatches} against `expect`, and require the handle and the
 *     path to be the same inode;
 *  2. the destination is absent;
 *  3. both parents are still bound, source then destination;
 *  4. the handle is still bound to the source path with the expected identity;
 *  5. the destination is absent AGAIN;
 *  6. `rename(source, destination)`, by path;
 *  7. `afterRename()`, awaited WHILE THE SOURCE HANDLE IS STILL OPEN; its
 *     boolean is the result;
 *  8. the handle is closed, best effort, in a `finally`.
 *
 * `false` on every refusal and on every throw, including a failed rename
 * (for example across devices) and a throwing `afterRename`. There is no copy
 * and no unlink: a failed rename is a failed move. Nothing is undone when
 * `afterRename` reports a conflict after the rename has happened.
 *
 * Pure Node 24 has no renameat/openat or FileHandle rename. The source handle
 * remains open and both parents are rebound immediately before `rename`, but a
 * non-cooperating same-user process can still win the final path-syscall gap.
 */
export async function moveGuardedLeaf(request: GuardedLeafMoveRequest): Promise<boolean> {
  let sourceHandle: FileHandle | null = null;
  try {
    sourceHandle = await openMoveSource(request);
    if (sourceHandle === null || !(await destinationIsAbsent(request.destination))) return false;
    if (!(await parentsStillBound(request.root, request.parents))) return false;
    if (!(await handleStillBound(sourceHandle, request.source, request.expect.fileIdentity))) return false;
    if (!(await destinationIsAbsent(request.destination))) return false;
    await rename(request.source, request.destination);
    return await request.afterRename();
  } catch {
    return false;
  } finally {
    await sourceHandle?.close().catch(() => {});
  }
}

/**
 * NO GUARD. Whether anything, a link included, is at `<dir>/<leafName>`:
 * `lstat` succeeding is `true`, `ENOENT` is `false`, and any other failure
 * REJECTS with the raw error.
 */
export async function leafPresent(dir: string, leafName: string): Promise<boolean> {
  try {
    await lstat(path.join(dir, leafName));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * EXISTING WRITER'S PROPERTY ONLY. Publish a new leaf through the incumbent
 * no-replace atomic writer, confined to the resolved project root. It never
 * replaces an existing destination, and it is not made durable. The caller's
 * `afterParentCheck` runs after the writer's parent check and before the
 * commit; `afterCommit` runs after it. The root is resolved first, then the
 * writer runs; both reject with their own errors, which pass through.
 */
export async function createLeafNoReplace(request: LeafCreateRequest): Promise<void> {
  await atomicWriteNoReplace(request.leaf, request.text, {
    confineRoot: await realpath(request.root),
    afterParentCheckForTest: request.afterParentCheck,
    afterNoReplaceCommitForTest: request.afterCommit,
  });
}

/**
 * EXISTING WRITER'S PROPERTY ONLY. Replace a leaf's content through the
 * incumbent atomic writer, confined to the resolved project root. A reader
 * sees the old or the new content. It does not check which object is at the
 * path and is not made durable. Rejections pass through.
 */
export async function replaceLeafAtomic(root: string, leaf: string, text: string): Promise<void> {
  await atomicWrite(leaf, text, { confineRoot: await realpath(root) });
}

/**
 * EXISTING WRITER'S PROPERTY ONLY, AND NOT CONFINED. `atomicWrite(leaf, text)`
 * with no options: a reader sees the old or the new content, and the writer
 * applies its own leaf and parent checks. It is given NO confine root, so it
 * does not prove the leaf is inside any project; the caller must have confined
 * the path already. Not made durable. Rejections pass through.
 */
export async function writeLeafAtomicUnconfined(leaf: string, text: string): Promise<void> {
  await atomicWrite(leaf, text);
}

/**
 * CARRIES THE CONFINED READ'S GUARD, which is not {@link readGuardedLeaf}'s.
 * `readConfinedLeaf(root, leaf, expectedDir, maxBytes, opts)` exactly: `root`
 * is passed as given (not resolved here), `expectedDir` is the caller's and
 * may be lexical, the result is text, and a refusal is the value `absent`
 * (`ENOENT` only) or `unavailable` (a link, a non-regular file, a parent that
 * does not bind, or more than `maxBytes`). No identity is returned.
 *
 * `opts` are the primitive's own options, passed through unchanged. They are
 * not only test hooks: `requireSingleLink` is a production policy that refuses
 * a hard-linked file. Omitted, they default to `{}`, as the primitive's do.
 */
export async function readConfinedLeafText(
  root: string, leaf: string, expectedDir: string, maxBytes: number, opts: ReadLeafOptions = {},
): Promise<CappedLeafRead> {
  return readConfinedLeaf(root, leaf, expectedDir, maxBytes, opts);
}

/**
 * CARRIES THE CONFINED READ'S GUARD. The bytes sibling of
 * {@link readConfinedLeafText}: `readConfinedLeafBuffer` with the same five
 * arguments, the same refusals as values, and `opts` passed through unchanged
 * (including the production `requireSingleLink`).
 */
export async function readConfinedLeafBytes(
  root: string, leaf: string, expectedDir: string, maxBytes: number, opts: ReadLeafOptions = {},
): Promise<CappedLeafReadBuffer> {
  return readConfinedLeafBuffer(root, leaf, expectedDir, maxBytes, opts);
}

/**
 * CARRIES A CHECK ON THE LEAF ONLY, and is the one function here whose
 * refusals are NOT raw errors. It opens `leaf` without following a link and
 * accepts a regular file only; it confines nothing and checks no parent. The
 * content is decoded as UTF-8. EVERY open and read failure is deliberately
 * returned as `null`, so a caller cannot tell absent from unreadable. The one
 * thing that propagates is a rejecting `close`, which runs in `finally` and
 * so rejects even after a failure that was turned into `null`.
 */
export async function readLeafTextNoFollow(leaf: string): Promise<string | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await openFileNoFollow(leaf, constants.O_RDONLY | constants.O_NOFOLLOW);
    return await handle.readFile("utf-8");
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * EXISTING WRITER'S PROPERTY ONLY, CONFINED TO THE ROOT FORM GIVEN.
 * `atomicWrite(leaf, content, { confineRoot })`: a reader sees the old or the
 * new content. `confineRoot` is used exactly as the caller passes it, resolved
 * or not; the caller chooses the form and any fallback. Text or bytes pass
 * straight through. Not made durable. Rejections pass through.
 */
export async function replaceLeafAtomicWithin(confineRoot: string, leaf: string, content: string | Uint8Array): Promise<void> {
  await atomicWrite(leaf, content, { confineRoot });
}

/** NO GUARD. `mkdir(dir, { recursive: true })`. Rejects with the raw error. */
export async function makeDirectoryTree(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * NO GUARD, AND NOT A CUSTODY MOVE. `rename(from, to)`, by path: it checks no
 * identity, holds no handle, and REPLACES an existing destination. Rejects
 * with the raw error. Use {@link moveGuardedLeaf} where custody matters.
 */
export async function renameLeafUnguarded(from: string, to: string): Promise<void> {
  await rename(from, to);
}

/**
 * NO GUARD. `readdir(dir)`: names in code-unit order. Rejects with the raw error.
 * Node's libuv returned every listing sorted; Bun returns raw directory order,
 * so the sort keeps listing-derived output identical across runtimes.
 */
export async function listDirectoryNames(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

/**
 * NO GUARD. `readdir(dir, { withFileTypes: true })`: Node's own entries, in
 * the order returned, each answering `isFile()` and `isDirectory()` for the
 * entry itself with no link followed. Returns Node's promise itself, so a
 * caller's `.catch` sees the raw rejection. `Dirent` is the LOCAL DISK's type,
 * not a store contract.
 */
export function listDirectoryEntries(dir: string): Promise<Dirent[]> {
  return readdir(dir, { withFileTypes: true });
}

/**
 * NO GUARD. `readdir(dir, { recursive: true, withFileTypes: true })` on the
 * local disk: the entries below `dir` exactly as Node returns them, in Node's
 * order, with those two options and no others. Returns Node's promise itself.
 * REJECTS with the raw error.
 */
export function listDirectoryEntriesRecursive(dir: string): Promise<Dirent[]> {
  return readdir(dir, { recursive: true, withFileTypes: true });
}

/** NO GUARD. `unlink(leaf)`, by path. Rejects with the raw error. */
export async function removeLeaf(leaf: string): Promise<void> {
  await unlink(leaf);
}
