/**
 * @file src/compiler/candidate-custody.ts
 * @description Bounded candidate-byte custody and the connector-only confined
 * move primitive. Selection captures exact raw-byte, inode, and candidate-store
 * evidence. Archive and restore then derive fresh paths from a validated root
 * and file id, keep the verified source handle open through one same-store
 * rename, and accept only exact digest-bound post-states. No copy/unlink fallback
 * exists here: an unavailable path, parent drift, or cross-device rename fails
 * closed and remains subject to the connector compensation adapter.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, opendir, realpath, rename } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { archivePath, assertCandidateId, candidatePath } from "./candidate-paths.js";
import { CANDIDATES_ARCHIVE_DIR, CANDIDATES_DIR } from "../utils/constants.js";
import { openConfinedLeaf } from "../utils/confined-read.js";
import { candidateByteLimit, type CandidateCustodyPolicy } from "./candidate-custody-limits.js";
import {
  captureCandidateCustodyMoveRequest,
  captureCandidateCustodyReceipt,
} from "./candidate-custody-snapshot.js";
import {
  captureCandidateDirectoryBinding,
  type CandidateDirectoryBinding,
} from "./candidate-store-paths.js";

export { MAX_CANDIDATE_RECORD_BYTES } from "./candidate-custody-limits.js";

/** Stable filesystem identity used to bind candidate files and their store. */
export interface CandidateFileIdentity {
  readonly dev: number;
  readonly ino: number;
}

/** Exact evidence retained across one in-process archive/restore sequence. */
export interface CandidateCustodyReceipt {
  readonly fileId: string;
  readonly byteCount: number;
  readonly sha256: string;
  readonly fileIdentity: CandidateFileIdentity;
  readonly storeIdentity: CandidateFileIdentity;
}

/** Raw bounded selection evidence; callers parse bytes then retain only receipt. */
export interface CandidateCustodyRead {
  readonly bytes: Buffer;
  readonly receipt: CandidateCustodyReceipt;
}

/** Store-owned move direction; neither caller-supplied path is accepted. */
export type CandidateCustodyMoveDirection = "archive" | "restore";

/** Complete authority supplied to the connector candidate move primitive. */
export interface CandidateCustodyMoveRequest {
  readonly root: string;
  readonly fileId: string;
  readonly direction: CandidateCustodyMoveDirection;
  readonly receipt: CandidateCustodyReceipt;
}

/** Fixed failure for candidate bytes that cannot safely authorize mutation. */
export class CandidateCustodyUnavailableError extends Error {
  constructor() {
    super("candidate custody is unavailable");
    this.name = "CandidateCustodyUnavailableError";
  }
}

/** One unreadable leaf in a still-bound store; discovery may skip this file. */
export class CandidateLeafUnavailableError extends CandidateCustodyUnavailableError {
  constructor() {
    super();
    this.name = "CandidateLeafUnavailableError";
  }
}

/** Exact observable candidate state used by archive and compensation. */
export type CandidateCustodyState = "restored" | "archived" | "conflict";

type CandidateLocation = "pending" | "archive";

export type CandidateStoreBinding = CandidateDirectoryBinding;

type DirectoryBinding = CandidateDirectoryBinding;

type CustodyLeafRead =
  | { kind: "absent" }
  | { kind: "unavailable" }
  | { kind: "ok"; bytes: Buffer; fileIdentity: CandidateFileIdentity };

type CandidateLocationBinding =
  | { kind: "absent" }
  | { kind: "unavailable" }
  | { kind: "ok"; binding: DirectoryBinding };

/** Compare stable filesystem identities without coercion. */
function sameIdentity(left: CandidateFileIdentity, right: CandidateFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Hash exact raw bytes for custody comparison. */
function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Lexical candidate directory for one leaf location. */
function candidateDir(root: string, location: CandidateLocation): string {
  const relative = location === "pending" ? CANDIDATES_DIR : CANDIDATES_ARCHIVE_DIR;
  return path.join(root, relative);
}

/** Derive one confined candidate path from root, id, and location. */
function candidateLeaf(root: string, fileId: string, location: CandidateLocation): Promise<string> {
  return location === "pending" ? candidatePath(root, fileId) : archivePath(root, fileId);
}

/** Capture one confined, root-anchored directory identity. */
async function captureDirectory(root: string, dir: string): Promise<DirectoryBinding | null> {
  const relative = path.relative(path.resolve(root), path.resolve(dir));
  return captureCandidateDirectoryBinding(root, relative);
}

/** Re-prove that a captured directory still names the same canonical inode. */
async function directoryStillBound(root: string, binding: DirectoryBinding): Promise<boolean> {
  try {
    const current = await captureDirectory(root, binding.dir);
    return current !== null && current.realDir === binding.realDir &&
      sameIdentity(current.identity, binding.identity);
  } catch {
    return false;
  }
}

/** Capture the pending candidate-store root, optionally against a receipt. */
async function captureStore(
  root: string,
  expected?: CandidateFileIdentity,
): Promise<DirectoryBinding | null> {
  const binding = await captureDirectory(root, candidateDir(root, "pending"));
  if (binding === null || (expected && !sameIdentity(binding.identity, expected))) return null;
  return binding;
}

/** Capture one pending-store binding, distinguishing only genuine absence. */
export async function captureCandidateStoreBinding(
  root: string,
  requireLiteral = false,
): Promise<CandidateStoreBinding | null> {
  return captureCandidateDirectoryBinding(root, CANDIDATES_DIR, requireLiteral);
}

/** Prove effective access to one existing directory and rebind it afterward. */
async function assertDirectoryAccess(
  root: string,
  binding: DirectoryBinding,
  mode: number,
): Promise<void> {
  try {
    await access(binding.realDir, mode);
    if (!(await directoryStillBound(root, binding))) {
      throw new CandidateCustodyUnavailableError();
    }
  } catch {
    throw new CandidateCustodyUnavailableError();
  }
}

/** Prove one existing owned namespace can be searched and enumerated. */
async function assertDirectoryReadable(
  root: string,
  binding: DirectoryBinding,
): Promise<void> {
  let directory: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    await assertDirectoryAccess(root, binding, constants.R_OK | constants.X_OK);
    directory = await opendir(binding.realDir);
    await directory.close();
    directory = undefined;
    if (!(await directoryStillBound(root, binding))) {
      throw new CandidateCustodyUnavailableError();
    }
  } catch {
    await directory?.close().catch(() => {});
    throw new CandidateCustodyUnavailableError();
  }
}

/** Validate both owned namespaces and reject any shared filesystem identity. */
export async function assertCandidateNamespacesHealthy(root: string): Promise<void> {
  const pending = await captureDirectory(root, candidateDir(root, "pending"));
  if (pending) await assertDirectoryReadable(root, pending);
  const archive = await captureDirectory(root, candidateDir(root, "archive"));
  if (pending && archive && sameIdentity(pending.identity, archive.identity)) {
    throw new CandidateCustodyUnavailableError();
  }
  if (archive) await assertDirectoryReadable(root, archive);
}

/** Prove one existing namespace or its literal creation parent can be mutated. */
async function assertMutationTargetWritable(root: string, target: string): Promise<void> {
  const existing = await captureDirectory(root, target);
  const binding = existing ?? await captureDirectory(root, path.dirname(target));
  if (binding === null) throw new CandidateCustodyUnavailableError();
  await assertDirectoryAccess(root, binding, constants.W_OK | constants.X_OK);
}

/** Prove the candidate effects one plan may need before external or live work. */
export async function assertCandidateMutationAccess(
  root: string,
  requiresArchiveInsert: boolean,
): Promise<void> {
  await assertCandidateNamespacesHealthy(root);
  await assertMutationTargetWritable(root, candidateDir(root, "pending"));
  if (requiresArchiveInsert) {
    await assertMutationTargetWritable(root, candidateDir(root, "archive"));
  }
}

/** Re-prove that the lexical pending store still owns one captured identity. */
export async function assertCandidateStoreBinding(
  root: string,
  expected: CandidateStoreBinding,
): Promise<void> {
  const current = await captureStore(root, expected.identity);
  if (current === null || current.dir !== expected.dir || current.realDir !== expected.realDir) {
    throw new CandidateCustodyUnavailableError();
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
  fileIdentity: CandidateFileIdentity,
): Promise<boolean> {
  const [opened, current] = await Promise.all([handle.stat(), lstat(leaf)]);
  return opened.isFile() && sameIdentity(opened, fileIdentity) &&
    sameIdentity(current, fileIdentity);
}

/** Bind the exact pending or archive directory without conflating an alias with absence. */
async function captureLocationBinding(
  root: string,
  location: CandidateLocation,
  store: DirectoryBinding,
): Promise<CandidateLocationBinding> {
  if (location === "pending") return { kind: "ok", binding: store };
  const archive = await captureDirectory(root, candidateDir(root, "archive"));
  if (archive === null) return { kind: "absent" };
  if (sameIdentity(store.identity, archive.identity)) return { kind: "unavailable" };
  return { kind: "ok", binding: archive };
}

/** Read and rebind one already confinement-proved candidate handle. */
async function consumeCustodyHandle(
  root: string,
  leaf: string,
  store: DirectoryBinding,
  location: DirectoryBinding,
  opened: Extract<Awaited<ReturnType<typeof openConfinedLeaf>>, { kind: "confirmed" }>,
): Promise<CustodyLeafRead> {
  try {
    const info = await opened.handle.stat();
    const identity = { dev: info.dev, ino: info.ino };
    const bytes = await readExactHandle(opened.handle, opened.size);
    const leafBound = await handleStillBound(opened.handle, leaf, identity).catch(() => false);
    const parentsBound = await directoryStillBound(root, store) &&
      await directoryStillBound(root, location);
    return bytes && leafBound && parentsBound
      ? { kind: "ok", bytes, fileIdentity: identity }
      : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/** Open and read one location through the root-anchored no-follow seam. */
async function readCustodyLeaf(
  root: string,
  fileId: string,
  location: CandidateLocation,
  expectedStore?: CandidateFileIdentity,
  policy: CandidateCustodyPolicy = "bounded",
): Promise<CustodyLeafRead> {
  const store = await captureStore(root, expectedStore);
  if (store === null) return { kind: "unavailable" };
  const locationBinding = await captureLocationBinding(root, location, store);
  if (locationBinding.kind !== "ok") return locationBinding;
  const leaf = await candidateLeaf(root, fileId, location).catch(() => null);
  if (leaf === null) return { kind: "unavailable" };
  const opened = await openConfinedLeaf(await realpath(root), leaf, locationBinding.binding.realDir);
  if (opened.kind !== "confirmed") return opened;
  if (opened.size > candidateByteLimit(policy)) {
    await opened.handle.close().catch(() => {});
    return { kind: "unavailable" };
  }
  return consumeCustodyHandle(root, leaf, store, locationBinding.binding, opened);
}

/** Capture exact bounded pending-candidate bytes and receipt evidence. */
export async function captureCandidateCustody(
  root: string,
  fileId: string,
  expectedStore?: CandidateStoreBinding,
  policy: CandidateCustodyPolicy = "bounded",
): Promise<CandidateCustodyRead | null> {
  assertCandidateId(fileId);
  // Preserve the store's public typed confinement refusal before custody can
  // classify an ordinary direct read as unavailable.
  await candidatePath(root, fileId);
  const store = await captureStore(root, expectedStore?.identity);
  if (store === null) {
    if (expectedStore === undefined) return null;
    throw new CandidateCustodyUnavailableError();
  }
  if (expectedStore && (store.dir !== expectedStore.dir || store.realDir !== expectedStore.realDir)) {
    throw new CandidateCustodyUnavailableError();
  }
  const read = await readCustodyLeaf(root, fileId, "pending", store.identity, policy);
  if (read.kind === "absent") return null;
  if (read.kind !== "ok") {
    await assertCandidateStoreBinding(root, store);
    throw new CandidateLeafUnavailableError();
  }
  const receipt = captureCandidateCustodyReceipt({
    fileId,
    byteCount: read.bytes.byteLength,
    sha256: sha256Bytes(read.bytes),
    fileIdentity: read.fileIdentity,
    storeIdentity: store.identity,
  }, policy);
  return Object.freeze({
    bytes: read.bytes,
    receipt,
  });
}

/** True when one read proves the exact receipt bytes and inode. */
function matchesReceipt(read: CustodyLeafRead, receipt: CandidateCustodyReceipt): boolean {
  return read.kind === "ok" && read.bytes.byteLength === receipt.byteCount &&
    sameIdentity(read.fileIdentity, receipt.fileIdentity) &&
    sha256Bytes(read.bytes) === receipt.sha256;
}

/** Observe only the two exact successful states admitted by D-048. */
export async function observeCandidateCustody(
  root: string,
  receipt: CandidateCustodyReceipt,
  policy: CandidateCustodyPolicy = "bounded",
): Promise<CandidateCustodyState> {
  try {
    const captured = captureCandidateCustodyReceipt(receipt, policy);
    const pending = await readCustodyLeaf(root, captured.fileId, "pending", captured.storeIdentity, policy);
    const archived = await readCustodyLeaf(root, captured.fileId, "archive", captured.storeIdentity, policy);
    if (matchesReceipt(pending, captured) && archived.kind === "absent") return "restored";
    if (pending.kind === "absent" && matchesReceipt(archived, captured)) return "archived";
    return "conflict";
  } catch {
    return "conflict";
  }
}

/** Ensure the archive parent exists and bind both candidate-store parents. */
async function bindMoveParents(
  request: CandidateCustodyMoveRequest,
): Promise<{ source: DirectoryBinding; destination: DirectoryBinding } | null> {
  const store = await captureStore(request.root, request.receipt.storeIdentity);
  if (store === null) return null;
  const archiveDir = candidateDir(request.root, "archive");
  if (request.direction === "archive") await mkdir(archiveDir).catch(() => {});
  const archive = await captureDirectory(request.root, archiveDir);
  if (archive === null || sameIdentity(store.identity, archive.identity) ||
      !(await directoryStillBound(request.root, store))) return null;
  return request.direction === "archive"
    ? { source: store, destination: archive }
    : { source: archive, destination: store };
}

/** Require an exact receipt-bound source while retaining its open handle. */
async function openMoveSource(
  request: CandidateCustodyMoveRequest,
  source: string,
  sourceDir: string,
  policy: CandidateCustodyPolicy,
): Promise<FileHandle | null> {
  const opened = await openConfinedLeaf(await realpath(request.root), source, sourceDir);
  if (opened.kind !== "confirmed") return null;
  if (opened.size > candidateByteLimit(policy)) {
    await opened.handle.close().catch(() => {});
    return null;
  }
  let accepted = false;
  try {
    const info = await opened.handle.stat();
    const identity = { dev: info.dev, ino: info.ino };
    const bytes = await readExactHandle(opened.handle, opened.size);
    const read: CustodyLeafRead = bytes
      ? { kind: "ok", bytes, fileIdentity: identity }
      : { kind: "unavailable" };
    if (!matchesReceipt(read, request.receipt)) return null;
    if (!(await handleStillBound(opened.handle, source, identity))) return null;
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
  parents: { source: DirectoryBinding; destination: DirectoryBinding },
): Promise<boolean> {
  return (await directoryStillBound(root, parents.source)) &&
    (await directoryStillBound(root, parents.destination));
}

/** Derive source and destination paths for one store-owned move request. */
async function movePaths(request: CandidateCustodyMoveRequest): Promise<[string, string]> {
  const pending = await candidatePath(request.root, request.fileId);
  const archived = await archivePath(request.root, request.fileId);
  return request.direction === "archive" ? [pending, archived] : [archived, pending];
}

/**
 * Rename one exact candidate within its bound store and verify the post-state.
 * Pure Node 24 has no renameat/openat or FileHandle rename. The source handle
 * remains open and both parents are rebound immediately before `rename`, but a
 * non-cooperating same-user process can still win the final path-syscall gap.
 */
export async function moveCandidateWithCustody(
  request: CandidateCustodyMoveRequest,
  policy: CandidateCustodyPolicy = "bounded",
): Promise<boolean> {
  const captured = captureCandidateCustodyMoveRequest(request, policy);
  let sourceHandle: FileHandle | null = null;
  try {
    const parents = await bindMoveParents(captured);
    if (parents === null) return false;
    const [source, destination] = await movePaths(captured);
    sourceHandle = await openMoveSource(captured, source, parents.source.realDir, policy);
    if (sourceHandle === null || !(await destinationIsAbsent(destination))) return false;
    if (!(await parentsStillBound(captured.root, parents))) return false;
    if (!(await handleStillBound(sourceHandle, source, captured.receipt.fileIdentity))) return false;
    if (!(await destinationIsAbsent(destination))) return false;
    await rename(source, destination);
    return await observeCandidateCustody(captured.root, captured.receipt, policy) === captured.direction + "d";
  } catch {
    return false;
  } finally {
    await sourceHandle?.close().catch(() => {});
  }
}
