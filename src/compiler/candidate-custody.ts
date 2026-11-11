/**
 * @file src/compiler/candidate-custody.ts
 * @description Bounded candidate-byte custody and the connector-only confined
 * move primitive. Selection captures exact raw-byte, inode, and candidate-store
 * evidence. Archive and restore then derive fresh paths from a validated root
 * and file id, keep the verified source handle open through one same-store
 * rename, and accept only exact digest-bound post-states. No copy/unlink fallback
 * exists here: an unavailable path, parent drift, or cross-device rename fails
 * closed and remains subject to the connector compensation adapter.
 *
 * THE CUSTODY READS HAVE ONE BODY EACH, over {@link CandidateCustodyReads}:
 * {@link captureCandidateCustodyFrom} and {@link observeCandidateCustodyFrom}.
 * The domain stays here: id admission before any store access, the typed
 * confinement refusal first, the store binding and its re-proof, which
 * location is read and in what order, what absence, leaf unavailability and
 * store unavailability each mean, the byte policy, and the receipt. The
 * bound members are LOCAL PHYSICAL MECHANISMS (a directory binding, leaf
 * confinement, the guarded read) whose identities are device and inode
 * numbers; this is not a port for any other backend. The namespace check, the
 * mutation-access preflight and the candidate move have bound bodies too
 * ({@link assertCandidateNamespacesHealthyFrom},
 * {@link assertCandidateMutationAccessFrom}, {@link moveCandidateWithCustodyFrom}).
 */

import path from "node:path";
import { archivePath, assertCandidateId, candidatePath } from "./candidate-paths.js";
import { CANDIDATES_ARCHIVE_DIR, CANDIDATES_DIR } from "../utils/constants.js";
import { candidateByteLimit, type CandidateCustodyPolicy } from "./candidate-custody-limits.js";
import {
  captureCandidateCustodyMoveRequest,
  captureCandidateCustodyReceipt,
} from "./candidate-custody-snapshot.js";
import {
  captureCandidateDirectoryBinding,
  type CandidateDirectoryBinding,
} from "./candidate-store-paths.js";
import { diskRecordDirectory } from "../storage/disk-local-record-dirs.js";
import type { LocalRecordDirectory } from "../storage/legacy-local-record-dirs.js";
import {
  createLeafNoReplace,
  directoryStillBound as diskDirectoryStillBound,
  ensureDirectory,
  leafDigest,
  leafMatches,
  leafPresent,
  moveGuardedLeaf,
  probeDirectory,
  readGuardedLeaf,
  removeLeaf,
  replaceLeafAtomic,
  sameIdentity,
  enumerateSuffixedNames,
  type GuardedLeafMoveRequest,
  type GuardedLeafRead,
  type GuardedLeafReadRequest,
  type LeafCreateRequest,
  type SuffixedNameEnumeration,
} from "../storage/disk-guarded-leaves.js";

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

/** Which owned namespace a candidate leaf is in. */
export type CandidateLocation = "pending" | "archive";

export type CandidateStoreBinding = CandidateDirectoryBinding;

type DirectoryBinding = CandidateDirectoryBinding;

type CustodyLeafRead = GuardedLeafRead;

type CandidateLocationBinding =
  | { kind: "absent" }
  | { kind: "unavailable" }
  | { kind: "ok"; binding: DirectoryBinding };

/**
 * The raw custody-read MECHANISMS the capture and observation bodies run over.
 * Each member rejects with its own error, or returns a refusal value; the
 * custody body decides what each means.
 */
export interface CandidateCustodyReads {
  /**
   * MECHANISM (confined directory binding). The canonical binding of the owned
   * directory `relDir`, or `null` when a component is absent. Rejects with
   * `UnsafeCandidateDirError` when it escapes, is broken or is not a directory,
   * and, when `requireLiteral` is true, when any component is an alias.
   */
  captureDirectory(relDir: string, requireLiteral?: boolean): Promise<CandidateStoreBinding | null>;
  /** MECHANISM (leaf confinement). The confined leaf of `fileId` in `location`. Rejects with the store's typed refusal. */
  leafPath(fileId: string, location: CandidateLocation): Promise<string>;
  /**
   * MECHANISM (guarded physical read). The leaf's exact bytes and identity, read
   * while `store` and `location` stay bound and capped at `maxBytes`. Refusals
   * are values; it rejects only when the project root cannot be resolved.
   */
  readLeaf(request: Omit<GuardedLeafReadRequest, "root">): Promise<GuardedLeafRead>;
}

/** The custody-read mechanisms plus the one the strict whole-store scan needs. */
export interface CandidateStoreScanReads extends CandidateCustodyReads {
  /**
   * MECHANISM (guarded enumeration). The suffixed entry names of one bound
   * directory, in stream order, under the CALLER's caps, recheck, overflow
   * error and hooks, run in the mechanism's fixed order. Nothing is caught.
   */
  enumerate(binding: CandidateStoreBinding, enumeration: SuffixedNameEnumeration): Promise<string[]>;
}

/** The custody-read mechanisms plus the one the tolerant public listing needs. */
export interface CandidateStoreListReads extends CandidateCustodyReads {
  /**
   * RAW (the existing record-directory listing). The tolerant view of an
   * already-resolved directory: whether it still exists, and its direct
   * entries with their kinds, in the backend's order. Which entries count, and
   * what a listing fault means, are the caller's.
   */
  recordDirectory(realDir: string): LocalRecordDirectory;
}

/**
 * The listing mechanisms plus the raw effects the candidate WRITERS need. Each
 * member rejects with its own error or returns a refusal value; which leaf,
 * in what order, and what a fault means stay with the writer.
 */
export interface CandidateStoreWriteReads extends CandidateStoreListReads {
  /** MECHANISM (access probe). Effective `list` or `write` access to one bound directory, re-bound afterward; any failure is `false`. */
  probeDirectory(binding: CandidateStoreBinding, need: "list" | "write"): Promise<boolean>;
  /** RAW. Whether anything, a link included, is at `<dir>/<leafName>`; any fault but absence rejects raw. */
  leafPresent(dir: string, leafName: string): Promise<boolean>;
  /** MECHANISM (confined, atomic, no-replace create). Never replaces; an occupied leaf or a hook rejection rejects. */
  createLeaf(leaf: string, text: string, hooks: Pick<LeafCreateRequest, "afterParentCheck" | "afterCommit">): Promise<void>;
  /** MECHANISM (confined atomic replace). A reader sees the old or the new bytes; it does not check WHICH object is replaced. */
  replaceLeaf(leaf: string, text: string): Promise<void>;
  /** RAW. Remove one leaf by path; rejects with the raw fault. */
  removeLeaf(leaf: string): Promise<void>;
}

/** The writers' mechanisms plus the three the candidate move needs. */
export interface CandidateStoreMoveReads extends CandidateStoreWriteReads {
  /** NO GUARD. Create `relDir` (not recursively), every error ignored; the caller binds it afterward to learn anything. */
  ensureDirectory(relDir: string): Promise<void>;
  /** MECHANISM (re-proof). Whether a captured directory still names the same canonical inode; any failure is `false`. */
  directoryStillBound(binding: CandidateStoreBinding): Promise<boolean>;
  /**
   * MECHANISM (guarded move). Rename one leaf between two bound parents while
   * holding the verified source open; `false` on any physical refusal, else the
   * result of `afterRename`, which runs with the handle still held. Renames by
   * path after its last check (no handle-relative rename in Node).
   */
  moveLeaf(request: Omit<GuardedLeafMoveRequest, "root">): Promise<boolean>;
}

/**
 * LOCAL DISK. The custody-read mechanisms of the project at `root`: the
 * confined directory binding, the confined candidate paths, the guarded
 * leaf read, the guarded enumeration, the record-directory listing, the
 * access probe, the writers' raw effects and the move's mechanisms, all
 * closed over this `root`. Building it does no I/O. In no package index.
 */
export function diskCandidateCustodyReads(root: string): CandidateStoreScanReads & CandidateStoreMoveReads {
  return {
    captureDirectory: (relDir, requireLiteral) => captureCandidateDirectoryBinding(root, relDir, requireLiteral),
    enumerate: enumerateSuffixedNames,
    recordDirectory: diskRecordDirectory,
    leafPath: (fileId, location) => candidateLeaf(root, fileId, location),
    readLeaf: (request) => readGuardedLeaf({ root, ...request }),
    probeDirectory: (binding, need) => probeDirectory(root, binding, need),
    leafPresent,
    createLeaf: (leaf, text, hooks) => createLeafNoReplace({ root, leaf, text, ...hooks }),
    replaceLeaf: (leaf, text) => replaceLeafAtomic(root, leaf, text),
    removeLeaf,
    ensureDirectory: (relDir) => ensureDirectory(root, relDir),
    directoryStillBound: (binding) => diskDirectoryStillBound(root, binding),
    moveLeaf: (request) => moveGuardedLeaf({ root, ...request }),
  };
}

/** Derive one confined candidate path from root, id, and location. */
function candidateLeaf(root: string, fileId: string, location: CandidateLocation): Promise<string> {
  return location === "pending" ? candidatePath(root, fileId) : archivePath(root, fileId);
}

/** Capture the pending candidate-store root, optionally against a receipt. */
async function captureStoreFrom(
  reads: CandidateCustodyReads,
  expected?: CandidateFileIdentity,
): Promise<DirectoryBinding | null> {
  const binding = await reads.captureDirectory(CANDIDATES_DIR);
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

/** Prove effective write and search access to one existing directory and rebind it afterward. */
async function assertDirectoryAccessFrom(
  reads: CandidateStoreWriteReads,
  binding: DirectoryBinding,
): Promise<void> {
  if (!(await reads.probeDirectory(binding, "write"))) throw new CandidateCustodyUnavailableError();
}

/** Prove one existing owned namespace can be searched and enumerated. */
async function assertDirectoryReadableFrom(
  reads: CandidateStoreWriteReads,
  binding: DirectoryBinding,
): Promise<void> {
  if (!(await reads.probeDirectory(binding, "list"))) throw new CandidateCustodyUnavailableError();
}

/**
 * Validate both owned namespaces and reject any shared filesystem identity, over
 * the store mechanisms: THE ONE BODY. Pending first (bound, then readable), then archive; the two must not
 * share a filesystem identity; then archive readable. A namespace component
 * that escapes, is broken or is not a directory REJECTS from the directory
 * capture with `UnsafeCandidateDirError`, which propagates unchanged; a failed
 * probe or a shared identity is `CandidateCustodyUnavailableError`.
 */
export async function assertCandidateNamespacesHealthyFrom(reads: CandidateStoreWriteReads): Promise<void> {
  await candidateNamespacesHealthyFrom(reads);
}

/** {@link assertCandidateNamespacesHealthyFrom}, handing back the two bindings it proved (`null` = absent). */
export async function candidateNamespacesHealthyFrom(
  reads: CandidateStoreWriteReads,
): Promise<{ pending: DirectoryBinding | null; archive: DirectoryBinding | null }> {
  const pending = await reads.captureDirectory(CANDIDATES_DIR);
  if (pending) await assertDirectoryReadableFrom(reads, pending);
  const archive = await reads.captureDirectory(CANDIDATES_ARCHIVE_DIR);
  if (pending && archive && sameIdentity(pending.identity, archive.identity)) {
    throw new CandidateCustodyUnavailableError();
  }
  if (archive) await assertDirectoryReadableFrom(reads, archive);
  return { pending, archive };
}

/**
 * Prove one existing namespace (`relTarget`) or its literal creation parent can
 * be mutated. `proven` is the namespace's binding from the health check just
 * made: the write probe re-proves a binding is still current right after its
 * access check, so an existing one is probed as-is instead of captured again.
 * An absent one is looked up afresh (it may exist by now), then its parent.
 */
async function assertMutationTargetWritableFrom(
  reads: CandidateStoreWriteReads, relTarget: string, proven: DirectoryBinding | null,
): Promise<void> {
  const existing = proven ?? await reads.captureDirectory(relTarget);
  const binding = existing ?? await reads.captureDirectory(path.dirname(relTarget));
  if (binding === null) throw new CandidateCustodyUnavailableError();
  await assertDirectoryAccessFrom(reads, binding);
}

/** Prove the candidate effects one plan may need before external or live work. */
export async function assertCandidateMutationAccess(
  root: string,
  requiresArchiveInsert: boolean,
): Promise<void> {
  // `async` so that a throw while the disk mechanisms are built REJECTS.
  return assertCandidateMutationAccessFrom(diskCandidateCustodyReads(root), requiresArchiveInsert);
}

/**
 * {@link assertCandidateMutationAccess} over the store mechanisms: THE ONE
 * BODY. The namespace check, then pending (or its creation parent) writable,
 * then, only when an archive insert is planned, archive (or its parent).
 */
export async function assertCandidateMutationAccessFrom(
  reads: CandidateStoreWriteReads,
  requiresArchiveInsert: boolean,
): Promise<void> {
  const namespaces = await candidateNamespacesHealthyFrom(reads);
  await assertMutationTargetWritableFrom(reads, CANDIDATES_DIR, namespaces.pending);
  if (requiresArchiveInsert) {
    await assertMutationTargetWritableFrom(reads, CANDIDATES_ARCHIVE_DIR, namespaces.archive);
  }
}

/**
 * Re-prove, over the custody-read mechanisms, that the lexical pending store
 * still owns one captured identity: the same identity, directory and real
 * directory, or `CandidateCustodyUnavailableError`.
 */
export async function assertCandidateStoreBindingFrom(
  reads: CandidateCustodyReads,
  expected: CandidateStoreBinding,
): Promise<void> {
  const current = await captureStoreFrom(reads, expected.identity);
  if (current === null || current.dir !== expected.dir || current.realDir !== expected.realDir) {
    throw new CandidateCustodyUnavailableError();
  }
}

/** Bind the exact pending or archive directory without conflating an alias with absence. */
async function captureLocationBindingFrom(
  reads: CandidateCustodyReads,
  location: CandidateLocation,
  store: DirectoryBinding,
): Promise<CandidateLocationBinding> {
  if (location === "pending") return { kind: "ok", binding: store };
  const archive = await reads.captureDirectory(CANDIDATES_ARCHIVE_DIR);
  if (archive === null) return { kind: "absent" };
  if (sameIdentity(store.identity, archive.identity)) return { kind: "unavailable" };
  return { kind: "ok", binding: archive };
}

/** Bind one location and resolve its leaf, then read it through the guarded physical read. */
async function readCustodyLeafFrom(
  reads: CandidateCustodyReads,
  fileId: string,
  location: CandidateLocation,
  expectedStore?: CandidateFileIdentity,
  policy: CandidateCustodyPolicy = "bounded",
): Promise<CustodyLeafRead> {
  const store = await captureStoreFrom(reads, expectedStore);
  if (store === null) return { kind: "unavailable" };
  const resolveLeaf = () => reads.leafPath(fileId, location).catch(() => null);
  return readBoundCustodyLeafFrom(reads, location, store, resolveLeaf, policy);
}

/**
 * Read one leaf under a store binding the caller JUST captured. The guarded
 * read itself confines `leaf` to the bound location's real directory and
 * re-proves both directory bindings after reading, so a leaf path resolved
 * just before the store capture is as safe as one resolved just after it.
 * `resolveLeaf` runs only once the location is bound.
 */
async function readBoundCustodyLeafFrom(
  reads: CandidateCustodyReads,
  location: CandidateLocation,
  store: DirectoryBinding,
  resolveLeaf: () => Promise<string | null>,
  policy: CandidateCustodyPolicy,
): Promise<CustodyLeafRead> {
  const locationBinding = await captureLocationBindingFrom(reads, location, store);
  if (locationBinding.kind !== "ok") return locationBinding;
  const leaf = await resolveLeaf();
  if (leaf === null) return { kind: "unavailable" };
  return reads.readLeaf({
    leaf, store, location: locationBinding.binding, maxBytes: candidateByteLimit(policy),
  });
}

/** Capture exact bounded pending-candidate bytes and receipt evidence. */
export async function captureCandidateCustody(
  root: string,
  fileId: string,
  expectedStore?: CandidateStoreBinding,
  policy: CandidateCustodyPolicy = "bounded",
): Promise<CandidateCustodyRead | null> {
  // `async` so that a throw while the disk mechanisms are built REJECTS.
  return captureCandidateCustodyFrom(diskCandidateCustodyReads(root), fileId, expectedStore, policy);
}

/** {@link captureCandidateCustody} over the custody-read mechanisms: THE ONE BODY. */
export async function captureCandidateCustodyFrom(
  reads: CandidateCustodyReads,
  fileId: string,
  expectedStore?: CandidateStoreBinding,
  policy: CandidateCustodyPolicy = "bounded",
): Promise<CandidateCustodyRead | null> {
  assertCandidateId(fileId);
  // Preserve the store's public typed confinement refusal before custody can
  // classify an ordinary direct read as unavailable.
  const leaf = await reads.leafPath(fileId, "pending");
  const store = await captureStoreFrom(reads, expectedStore?.identity);
  if (store === null) {
    if (expectedStore === undefined) return null;
    throw new CandidateCustodyUnavailableError();
  }
  if (expectedStore && (store.dir !== expectedStore.dir || store.realDir !== expectedStore.realDir)) {
    throw new CandidateCustodyUnavailableError();
  }
  // The store was captured just above: read under THAT binding with the leaf
  // already resolved, rather than capturing and resolving both again.
  const read = await readBoundCustodyLeafFrom(reads, "pending", store, async () => leaf, policy);
  if (read.kind === "absent") return null;
  if (read.kind !== "ok") {
    await assertCandidateStoreBindingFrom(reads, store);
    throw new CandidateLeafUnavailableError();
  }
  const receipt = captureCandidateCustodyReceipt({
    fileId,
    byteCount: read.bytes.byteLength,
    sha256: leafDigest(read.bytes),
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
  return leafMatches(read, receipt);
}

/** Observe only the two exact successful states admitted by D-048. */
export async function observeCandidateCustody(
  root: string,
  receipt: CandidateCustodyReceipt,
  policy: CandidateCustodyPolicy = "bounded",
): Promise<CandidateCustodyState> {
  // Never rejects: building the disk mechanisms does no I/O and cannot throw.
  return observeCandidateCustodyFrom(diskCandidateCustodyReads(root), receipt, policy);
}

/** {@link observeCandidateCustody} over the custody-read mechanisms: THE ONE BODY. */
export async function observeCandidateCustodyFrom(
  reads: CandidateCustodyReads,
  receipt: CandidateCustodyReceipt,
  policy: CandidateCustodyPolicy = "bounded",
): Promise<CandidateCustodyState> {
  try {
    const captured = captureCandidateCustodyReceipt(receipt, policy);
    const pending = await readCustodyLeafFrom(reads, captured.fileId, "pending", captured.storeIdentity, policy);
    const archived = await readCustodyLeafFrom(reads, captured.fileId, "archive", captured.storeIdentity, policy);
    if (matchesReceipt(pending, captured) && archived.kind === "absent") return "restored";
    if (pending.kind === "absent" && matchesReceipt(archived, captured)) return "archived";
    return "conflict";
  } catch {
    return "conflict";
  }
}

/** Ensure the archive parent exists and bind both candidate-store parents. */
async function bindMoveParentsFrom(
  reads: CandidateStoreMoveReads,
  request: CandidateCustodyMoveRequest,
): Promise<{ source: DirectoryBinding; destination: DirectoryBinding } | null> {
  const store = await captureStoreFrom(reads, request.receipt.storeIdentity);
  if (store === null) return null;
  if (request.direction === "archive") await reads.ensureDirectory(CANDIDATES_ARCHIVE_DIR);
  const archive = await reads.captureDirectory(CANDIDATES_ARCHIVE_DIR);
  if (archive === null || sameIdentity(store.identity, archive.identity) ||
      !(await reads.directoryStillBound(store))) return null;
  return request.direction === "archive"
    ? { source: store, destination: archive }
    : { source: archive, destination: store };
}

/** Derive source and destination paths for one store-owned move request. */
async function movePathsFrom(reads: CandidateStoreMoveReads, request: CandidateCustodyMoveRequest): Promise<[string, string]> {
  const pending = await reads.leafPath(request.fileId, "pending");
  const archived = await reads.leafPath(request.fileId, "archive");
  return request.direction === "archive" ? [pending, archived] : [archived, pending];
}

/**
 * Rename one exact candidate within its bound store and verify the post-state.
 * Pure Node 24 has no renameat/openat or FileHandle rename. The source handle
 * remains open and both parents are rebound immediately before `rename`, but a
 * non-cooperating same-user process can still win the final path-syscall gap.
 * The physical sequence is the guarded move in `../storage/disk-guarded-leaves.ts`;
 * the handle it holds stays open through the post-state observation below.
 */
export async function moveCandidateWithCustody(
  request: CandidateCustodyMoveRequest,
  policy: CandidateCustodyPolicy = "bounded",
): Promise<boolean> {
  // Capture FIRST, before `root` is read: a malformed request still rejects here.
  const captured = captureCandidateCustodyMoveRequest(request, policy);
  return moveCandidateWithCustodyFrom(diskCandidateCustodyReads(captured.root), captured, policy);
}

/**
 * {@link moveCandidateWithCustody} over the store mechanisms: THE ONE BODY. The
 * request is captured (again, idempotently) outside the `try`, so a malformed
 * one rejects before any mechanism call. Inside the `try`, every fault is
 * `false`: the store bound against the receipt, the archive created only for an
 * archive move, the two parents bound and distinct, the confined paths, and the
 * guarded move whose post-state is observed with the source handle held.
 *
 * The supplied `reads` choose the project. The request's `root` is a validated
 * legacy field of the move contract only: nothing here derives a mechanism, a
 * path, access or project identity from it, and it is not an authorization check.
 */
export async function moveCandidateWithCustodyFrom(
  reads: CandidateStoreMoveReads,
  request: CandidateCustodyMoveRequest,
  policy: CandidateCustodyPolicy = "bounded",
): Promise<boolean> {
  const captured = captureCandidateCustodyMoveRequest(request, policy);
  try {
    const parents = await bindMoveParentsFrom(reads, captured);
    if (parents === null) return false;
    const [source, destination] = await movePathsFrom(reads, captured);
    return await reads.moveLeaf({
      source,
      destination,
      parents,
      expect: captured.receipt,
      maxBytes: candidateByteLimit(policy),
      // Runs inside the guarded move, with the verified source handle still open.
      afterRename: async () =>
        await observeCandidateCustodyFrom(reads, captured.receipt, policy) === captured.direction + "d",
    });
  } catch {
    return false;
  }
}
