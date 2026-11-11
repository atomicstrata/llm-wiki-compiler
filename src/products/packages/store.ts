/**
 * @file src/products/packages/store.ts
 * @description The immutable, content-addressed product-package store (design
 * section 7.6). Bytes are staged into a fresh project-private temp directory
 * through the shared hardened create-only durable writer (no-follow, confined,
 * regular-file, fsynced), re-verified against their digests, fsynced, and then
 * atomically renamed to the digest-derived final path before the parent is
 * fsynced. Reads are confined, no-follow, single-link, and digest-verified, so a
 * symlinked leaf or parent, a foreign hard link, a FIFO or device leaf, and a
 * swapped or partial staged tree are all refused rather than trusted. Store-count
 * and byte ceilings are checked under the caller's project lock before the final
 * rename; distinct installs serialize under that lock and same-digest installs
 * converge after exact byte verification.
 *
 * READ SIDE: {@link readInstalledProductPackage} runs the one read body,
 * {@link readInstalledProductPackageFrom}, over local-disk
 * {@link ProductPackageReads}. Every classification (digest, canonical manifest,
 * member order and first failure, the three directory failures, undeclared
 * leaves) is decided in that body; the reads only look.
 *
 * COMMIT SIDE: {@link commitProductPackage} runs the one commit body,
 * {@link commitProductPackageWith}, over {@link ProductPackageCommitStore}: the
 * convergence-before-capacity order, the ceilings, the token, stage, re-verify,
 * sync, rename, collision convergence and cleanup are decided there. The disk
 * staging keeps the incumbent create-only durable writes, confined re-reads,
 * best-effort syncs, real-directory rename and forced cleanup. The measurement
 * (partial and orphan bytes included) stays the incumbent disk walk.
 */

import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { TextDecoder } from "node:util";
import { canonicalBytes } from "../../profile/templates/signing/canonical.js";
import { removeTreeForced } from "../../storage/disk-bundle-tree.js";
import {
  createLeafNoReplaceDurableWith, locationByteSizeNoFollow, syncDirectoryBestEffort,
} from "../../storage/disk-durable-leaves.js";
import {
  listDirectoryEntries, makeDirectoryTree, readConfinedLeafBytes, renameLeafUnguarded,
} from "../../storage/disk-guarded-leaves.js";
import {
  checkConfinedLeafDigest, readConfinedLeafDigest, type ConfinedLeafDigestCheck, type ConfinedLeafDigestRead,
} from "../../storage/disk-handle-leaves.js";
import { locationKindNoFollow } from "../../storage/disk-local-reads.js";
import { locationRealPath } from "../../storage/disk-locations.js";
import type { LocalEntryKind } from "../../storage/legacy-local-reads.js";
import type { CappedLeafReadBuffer } from "../../utils/confined-read.js";
import { isInsideDir } from "../../utils/path-confine.js";
import {
  MAX_COMPOSITION_LOCK_BYTES, MAX_INSTALLED_PACKAGES_PER_PROJECT, MAX_KNOWLEDGE_PROFILE_BYTES,
  MAX_PRODUCT_MANIFEST_BYTES, MAX_PRODUCT_PACKAGE_STORE_BYTES, MAX_ROOT_OPERATIONS_PACK_BYTES,
} from "../constants.js";
import { assertProductDigest, digestDirectoryName, type Sha256Digest } from "../ids.js";
import { ProductBoundsError, ProductPackageError } from "../problems.js";
import { MANIFEST_FILENAME, MEMBERS_SEGMENT, productStorePaths, type ProductStorePaths } from "../paths.js";
import { loadProductPackageManifest } from "./verify.js";
import type { ProductPackageManifestV1 } from "../types.js";

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
const TEMP_TOKEN_BYTES = 16;

/**
 * Member bytes an installed-package read verified while it checked them, keyed
 * by the member's digest hex. Each is the exact content its digest was taken
 * over, in the same pass that classified the package `ok`.
 */
export type VerifiedMemberBytes = ReadonlyMap<string, Buffer>;

/**
 * Complete read classification for one installed immutable package. On `ok`,
 * `verifiedMembers` holds the knowledge-profile, operations-pack and
 * composition-lock members whose declared size is within their read cap, so the
 * resolver does not open and hash those leaves a second time.
 */
export type InstalledPackageRead =
  | { status: "ok"; manifest: ProductPackageManifestV1; verifiedMembers: VerifiedMemberBytes }
  | { status: "absent" }
  | { status: "invalid"; detail: string }
  | { status: "unavailable"; detail: string };

/** Whether a commit renamed fresh bytes or converged on an existing package. */
export type ProductPackageCommitResult = { status: "committed" | "converged" };

/** Measured store occupancy across installed, partial, and orphan bytes. */
export interface ProductStoreMeasurementV1 {
  installedCount: number;
  totalBytes: number;
}

/** One entry of a package directory listing: its name and what the ENTRY ITSELF is (no link followed). */
export interface PackageDirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

/** Which of an installed package's two directories: its own, or its members directory. */
export type PackageDirectory = "package" | "members";

/**
 * The looks an installed-package read takes at the immutable store. OWNED BY THE
 * PACKAGE READER: a narrow seam with one disk implementation. It is not
 * `ProjectStore`, not a hosted or access-control contract, and it selects no
 * backend. It carries NO classification. Caps are the caller's and are passed in.
 * Every leaf look is confined to its directory and refuses a link, a
 * non-regular file and a hard-linked file.
 */
export interface ProductPackageReads {
  /** The manifest leaf of package directory `packageHex`: its bytes, `absent`, or `unavailable`. Never rejects for those. */
  readManifestLeaf(packageHex: string, maxBytes: number): Promise<CappedLeafReadBuffer>;
  /** One member leaf checked against a byte count and its own digest (`memberHex`), without returning its bytes. */
  checkMemberLeaf(packageHex: string, memberHex: string, byteCount: number): Promise<ConfinedLeafDigestCheck>;
  /** The same check, classified identically, returning the checked bytes with `matches`. The caller bounds `byteCount`. */
  readCheckedMemberLeaf(packageHex: string, memberHex: string, byteCount: number): Promise<ConfinedLeafDigestRead>;
  /** What one of the package's two directories IS, without following a link. REJECTS raw, for a missing one too. */
  directoryKind(packageHex: string, directory: PackageDirectory): Promise<LocalEntryKind>;
  /** The direct entries of one of the package's two directories. REJECTS raw. */
  listDirectory(packageHex: string, directory: PackageDirectory): Promise<PackageDirEntry[]>;
  /** One member leaf's bytes, at most `maxBytes`: `ok`, `absent`, or `unavailable`. */
  readMemberLeaf(packageHex: string, memberHex: string, maxBytes: number): Promise<CappedLeafReadBuffer>;
}

/** The outcome of proving every member leaf beneath one package tree. */
type MemberLeavesOutcome = "ok" | { status: "invalid" | "unavailable"; detail: string };

/**
 * Verify every declared member leaf, digest by digest, IN MANIFEST ORDER,
 * stopping at the first that does not match. `checkMember` makes the one look at
 * a member (confined, single-link, stream-hashed against its digest and byte
 * count); what each outcome MEANS for the package is decided here. Shared by
 * the installed-package read and the staged-tree re-verification.
 */
async function verifyMemberLeaves(
  checkMember: (memberHex: string, byteCount: number) => Promise<ConfinedLeafDigestCheck>,
  manifest: ProductPackageManifestV1,
): Promise<MemberLeavesOutcome> {
  for (const member of manifest.members) {
    const check = await checkMember(digestDirectoryName(member.digest), member.byteCount);
    if (check === "absent") return { status: "invalid", detail: "member-absent" };
    if (check === "unavailable") return { status: "unavailable", detail: "member-leaf" };
    if (check === "differs") return { status: "invalid", detail: "member-bytes" };
  }
  return "ok";
}

/**
 * Read a real (non-symlinked) directory's entries, or classify the failure. The
 * kind comes from one no-follow look, so a link is never a directory. Both
 * the kind look AND the enumeration are caught HERE: a denied listing (an
 * execute-only directory, EACCES) is an `unavailable` classification, never a
 * thrown error that escapes the read-result contract into a caller's read or
 * activation path.
 */
async function readRealDir(
  reads: ProductPackageReads, packageHex: string, directory: PackageDirectory,
): Promise<PackageDirEntry[] | { status: "unavailable"; detail: string }> {
  const kind = await reads.directoryKind(packageHex, directory).catch(() => null);
  if (kind === null) return { status: "unavailable", detail: "dir-absent" };
  if (kind !== "directory") return { status: "unavailable", detail: "dir-not-real" };
  try {
    return await reads.listDirectory(packageHex, directory);
  } catch {
    return { status: "unavailable", detail: "dir-unreadable" };
  }
}

/** Whether one package-root entry is the declared manifest file or members directory. */
function isDeclaredPackageEntry(entry: PackageDirEntry): boolean {
  return (entry.name === MANIFEST_FILENAME && entry.isFile)
    || (entry.name === MEMBERS_SEGMENT && entry.isDirectory);
}

/**
 * Reject any leaf the manifest does not declare (section 7.6 unknown-leaves fail
 * closed): the package directory must hold EXACTLY the manifest and the members
 * directory, and members/ EXACTLY the declared member digest files. An undeclared
 * file, directory, or member — the bytes an attacker would plant — keeps the
 * package unresolved rather than accepted as `ok`.
 */
async function assertNoUndeclaredLeaves(
  reads: ProductPackageReads, packageHex: string, manifest: ProductPackageManifestV1,
): Promise<MemberLeavesOutcome> {
  const pkg = await readRealDir(reads, packageHex, "package");
  if (!Array.isArray(pkg)) return pkg;
  if (pkg.some((entry) => !isDeclaredPackageEntry(entry))) return { status: "invalid", detail: "undeclared-package-leaf" };
  const members = await readRealDir(reads, packageHex, "members");
  if (!Array.isArray(members)) return members;
  const declared = new Set(manifest.members.map((member) => digestDirectoryName(member.digest)));
  if (members.some((entry) => !entry.isFile || !declared.has(entry.name))) {
    return { status: "invalid", detail: "undeclared-member-leaf" };
  }
  return "ok";
}

/** Decode, load, and bind one confined manifest leaf to its directory digest. */
function bindManifest(body: Buffer, hex: string): ProductPackageManifestV1 {
  const manifest = loadProductPackageManifest(STRICT_UTF8.decode(body));
  if (!canonicalBytes(manifest).equals(body)) throw new ProductPackageError("stored manifest is not canonical");
  if (digestDirectoryName(manifest.packageDigest) !== hex) {
    throw new ProductPackageError("package directory does not match its manifest digest");
  }
  return manifest;
}

/**
 * Resolve one installed package by an OFFLINE confined read: the manifest leaf,
 * its canonical bytes and directory binding, and every member leaf's digest. Any
 * missing, swapped, or corrupt byte keeps the package unresolved.
 */
export async function readInstalledProductPackage(
  root: string, packageDigest: Sha256Digest,
): Promise<InstalledPackageRead> {
  // `async`, and the disk reads build no path until a look is made: a malformed digest is classified by the one
  // body before `root` is touched, and a bad root REJECTS, both as this function always did.
  return readInstalledProductPackageFrom(diskProductPackageReads(root), packageDigest);
}

/**
 * {@link readInstalledProductPackage} over {@link ProductPackageReads}: THE ONE
 * BODY. A malformed digest makes no read at all. Then, in order: the manifest
 * leaf; its canonical and directory-name checks; every member in manifest order,
 * stopping at the first failure; the package directory, then the members
 * directory, each for undeclared entries. Nothing here is caught except what
 * the classifications name, so a read that REJECTS rejects this read.
 */
export async function readInstalledProductPackageFrom(
  reads: ProductPackageReads, packageDigest: Sha256Digest,
): Promise<InstalledPackageRead> {
  let hex: string;
  try {
    hex = digestDirectoryName(assertProductDigest(packageDigest));
  } catch {
    return { status: "unavailable", detail: "digest" };
  }
  const read = await reads.readManifestLeaf(hex, MAX_PRODUCT_MANIFEST_BYTES);
  if (read.kind === "absent") return { status: "absent" };
  if (read.kind !== "ok") return { status: "unavailable", detail: "manifest-leaf" };
  let manifest: ProductPackageManifestV1;
  try {
    manifest = bindManifest(read.body, hex);
  } catch (error) {
    return { status: "invalid", detail: error instanceof Error ? error.message : "manifest-invalid" };
  }
  const verifiedMembers = new Map<string, Buffer>();
  const members = await verifyMemberLeaves(memberCheckKeeping(reads, hex, manifest, verifiedMembers), manifest);
  if (members !== "ok") return members;
  const undeclared = await assertNoUndeclaredLeaves(reads, hex, manifest);
  return undeclared === "ok" ? { status: "ok", manifest, verifiedMembers } : undeclared;
}

/**
 * The members the resolver reads after this check, each with the cap it reads
 * it under: the knowledge profile, the root operations pack and the composition
 * lock. Their checked bytes are kept so those reads need not repeat the check.
 */
function retainedMemberCaps(manifest: ProductPackageManifestV1): Map<string, number> {
  return new Map([
    [digestDirectoryName(manifest.knowledgeProfile.digest), MAX_KNOWLEDGE_PROFILE_BYTES],
    [digestDirectoryName(manifest.rootOperationsPack.digest), MAX_ROOT_OPERATIONS_PACK_BYTES],
    [digestDirectoryName(manifest.compositionLock.digest), MAX_COMPOSITION_LOCK_BYTES],
  ]);
}

/**
 * The per-member check of {@link readInstalledProductPackageFrom}. A retained
 * member within its cap is checked by the read that keeps its bytes, and they
 * are added to `kept` on `matches`; every other member by the plain check.
 * Both classify identically, so the package outcome is the same either way. A
 * member over its cap is never buffered: its later capped read refuses it.
 */
function memberCheckKeeping(
  reads: ProductPackageReads, hex: string, manifest: ProductPackageManifestV1, kept: Map<string, Buffer>,
): (memberHex: string, byteCount: number) => Promise<ConfinedLeafDigestCheck> {
  const caps = retainedMemberCaps(manifest);
  return async (memberHex, byteCount) => {
    const cap = caps.get(memberHex);
    if (cap === undefined || byteCount > cap) return reads.checkMemberLeaf(hex, memberHex, byteCount);
    const read = await reads.readCheckedMemberLeaf(hex, memberHex, byteCount);
    if (read.kind === "matches") kept.set(memberHex, read.bytes);
    return read.kind;
  };
}

/**
 * LOCAL DISK. The installed-package looks for the project at `root`. Building it
 * does no I/O and reads nothing of `root`: the store paths are derived LAZILY,
 * inside each look, so a caller that never looks (a malformed digest) never
 * meets a bad root. Deriving them is pure string work. Each look is the storage
 * call the reader always made, with the same arguments: confined to the package
 * or members directory, single-link. In no package index.
 */
export function diskProductPackageReads(root: string): ProductPackageReads {
  const paths = () => productStorePaths(root);
  const directoryOf = (hex: string, directory: PackageDirectory): string =>
    directory === "package" ? paths().packageDir(hex) : paths().membersRoot(hex);
  return {
    readManifestLeaf: (hex, maxBytes) =>
      readConfinedLeafBytes(root, paths().manifestFile(hex), paths().packageDir(hex), maxBytes, { requireSingleLink: true }),
    checkMemberLeaf: (hex, memberHex, byteCount) => checkConfinedLeafDigest(
      root, paths().memberFile(hex, memberHex), paths().membersRoot(hex), { sha256Hex: memberHex, byteCount }, { requireSingleLink: true }),
    readCheckedMemberLeaf: (hex, memberHex, byteCount) => readConfinedLeafDigest(
      root, paths().memberFile(hex, memberHex), paths().membersRoot(hex), { sha256Hex: memberHex, byteCount }, { requireSingleLink: true }),
    directoryKind: (hex, directory) => locationKindNoFollow(directoryOf(hex, directory)),
    listDirectory: async (hex, directory) => (await listDirectoryEntries(directoryOf(hex, directory)))
      .map((entry) => ({ name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory() })),
    readMemberLeaf: (hex, memberHex, maxBytes) =>
      readConfinedLeafBytes(root, paths().memberFile(hex, memberHex), paths().membersRoot(hex), maxBytes, { requireSingleLink: true }),
  };
}

/** Count installed package directories, tolerating an absent store root. */
async function countChildDirectories(dir: string): Promise<number> {
  try {
    const entries = await listDirectoryEntries(dir);
    return entries.filter((entry) => entry.isDirectory()).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

/** Sum every regular-file byte under a root without following symlinks. */
async function sumRegularFileBytes(rootDir: string): Promise<number> {
  let total = 0;
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await listDirectoryEntries(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const full = `${current}/${entry.name}`;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) total += await locationByteSizeNoFollow(full);
    }
  }
  return total;
}

/** Measure installed count and total store bytes, including partial and orphan bytes. */
export async function measureProductPackageStore(root: string): Promise<ProductStoreMeasurementV1> {
  const paths = productStorePaths(root);
  return {
    installedCount: await countChildDirectories(paths.sha256Root),
    totalBytes: await sumRegularFileBytes(paths.storeRoot),
  };
}

/** Total incoming bytes one new package contributes to the store ceiling. */
function incomingBytes(manifest: ProductPackageManifestV1, manifestBytes: Buffer): number {
  let total = manifestBytes.byteLength;
  for (const member of manifest.members) total += member.byteCount;
  return total;
}

/** Enforce the store-count and byte ceilings under the caller's project lock. */
export async function assertProductStoreCapacity(root: string, incoming: number): Promise<void> {
  assertMeasuredCapacity(await measureProductPackageStore(root), incoming);
}

/** The two ceilings over one measurement: PURE, shared by the root form and the commit body. */
function assertMeasuredCapacity(measured: ProductStoreMeasurementV1, incoming: number): void {
  if (measured.installedCount + 1 > MAX_INSTALLED_PACKAGES_PER_PROJECT) {
    throw new ProductBoundsError("installed product packages per project");
  }
  if (measured.totalBytes + incoming > MAX_PRODUCT_PACKAGE_STORE_BYTES) {
    throw new ProductBoundsError("total product-package store bytes");
  }
}

/** Write one durable, confined, create-only leaf beneath the project temp tree. */
async function writeTempLeaf(root: string, file: string, bytes: Buffer): Promise<void> {
  await createLeafNoReplaceDurableWith(file, bytes, { confineRoot: root, exactParent: true, mode: 0o600 });
}

/**
 * One project-private staging tree for ONE commit token: its create-only writes,
 * its confined re-reads, its syncs, the move into place and the cleanup. Physical:
 * the disk implementation keeps the incumbent confinement and durability.
 */
export interface ProductPackageStaging {
  /** Create the staged manifest leaf. */
  writeManifest(bytes: Buffer): Promise<void>;
  /** Create one staged member leaf. */
  writeMember(memberHex: string, bytes: Buffer): Promise<void>;
  /** Re-read the staged manifest, single-link, within `maxBytes`. */
  readManifest(maxBytes: number): Promise<CappedLeafReadBuffer>;
  /** Re-check one staged member against its digest and byte count. */
  checkMember(memberHex: string, byteCount: number): Promise<ConfinedLeafDigestCheck>;
  /** Sync the staged members directory, then the staged package directory (best effort). */
  sync(): Promise<void>;
  /** Move the staged tree to its digest-derived place; false when an existing directory collides. */
  renameInto(digestHex: string): Promise<boolean>;
  /** Remove whatever staging is left; never rejects. */
  cleanup(): Promise<void>;
}

/** What one package commit asks of the project. No member takes a project root. */
export interface ProductPackageCommitStore {
  /** The installed package at a digest, classified. */
  readInstalled(packageDigest: Sha256Digest): Promise<InstalledPackageRead>;
  /** The installed count and total store bytes, partial and orphan bytes included. */
  measure(): Promise<ProductStoreMeasurementV1>;
  /** The staging tree for one token; building it does no I/O. */
  staging(token: string): ProductPackageStaging;
}

/** LOCAL DISK: the incumbent read, measurement and staging for one root, built per call. In no package index. */
function diskProductPackageCommitStore(root: string): ProductPackageCommitStore {
  return {
    readInstalled: (packageDigest) => readInstalledProductPackage(root, packageDigest),
    measure: () => measureProductPackageStore(root),
    staging: (token) => diskProductPackageStaging(root, token),
  };
}

/** The incumbent project-private staging tree under `root` for one token. */
function diskProductPackageStaging(root: string, token: string): ProductPackageStaging {
  const paths = productStorePaths(root);
  return {
    writeManifest: (bytes) => writeTempLeaf(root, paths.tmpManifestFile(token), bytes),
    writeMember: (memberHex, bytes) => writeTempLeaf(root, paths.tmpMemberFile(token, memberHex), bytes),
    readManifest: (maxBytes) => readConfinedLeafBytes(
      root, paths.tmpManifestFile(token), paths.tmpPackageDir(token), maxBytes, { requireSingleLink: true }),
    checkMember: (memberHex, byteCount) => checkConfinedLeafDigest(
      root, paths.tmpMemberFile(token, memberHex), paths.tmpMembersRoot(token), { sha256Hex: memberHex, byteCount }, { requireSingleLink: true }),
    sync: async () => {
      await syncDirectoryBestEffort(paths.tmpMembersRoot(token));
      await syncDirectoryBestEffort(paths.tmpPackageDir(token));
    },
    renameInto: (digestHex) => renameIntoPlace(root, paths, token, digestHex),
    cleanup: () => removeTreeForced(paths.tmpPackageDir(token)).catch(() => {}),
  };
}

/** Stage the manifest and every member into the staging tree. */
async function buildTempTree(
  staging: ProductPackageStaging, manifest: ProductPackageManifestV1,
  bytesByHex: ReadonlyMap<string, Buffer>, manifestBytes: Buffer,
): Promise<void> {
  await staging.writeManifest(manifestBytes);
  for (const member of manifest.members) {
    const hex = digestDirectoryName(member.digest);
    const bytes = bytesByHex.get(hex);
    if (bytes === undefined) throw new ProductPackageError("a member's bytes are missing while staging");
    await staging.writeMember(hex, bytes);
  }
}

/** Re-verify the complete staged bytes before the final rename. */
async function reverifyTempTree(staging: ProductPackageStaging, manifest: ProductPackageManifestV1): Promise<void> {
  const read = await staging.readManifest(MAX_PRODUCT_MANIFEST_BYTES);
  if (read.kind !== "ok" || !canonicalBytes(manifest).equals(read.body)) {
    throw new ProductPackageError("staged manifest failed re-verification");
  }
  const members = await verifyMemberLeaves((hex, byteCount) => staging.checkMember(hex, byteCount), manifest);
  if (members !== "ok") throw new ProductPackageError("staged member bytes failed re-verification");
}

/** Create the store parent, refusing a symlinked or escaping directory. */
async function ensureRealDir(root: string, dir: string): Promise<void> {
  await makeDirectoryTree(dir);
  if ((await locationKindNoFollow(dir)) === "link") throw new ProductPackageError("store directory is a symlink");
  if (!isInsideDir(await locationRealPath(dir), await locationRealPath(root))) {
    throw new ProductPackageError("store directory escapes the project root");
  }
}

/** Atomically rename the staged tree into place, converging on an existing digest. */
async function renameIntoPlace(root: string, paths: ProductStorePaths, token: string, hex: string): Promise<boolean> {
  await ensureRealDir(root, paths.sha256Root);
  try {
    // A DIRECTORY is renamed here, not a leaf. The helper's "replaces an existing
    // destination" does not hold for a non-empty directory: that rename REJECTS
    // with EEXIST or ENOTEMPTY, and this commit RELIES on that rejection to
    // detect a colliding digest directory.
    await renameLeafUnguarded(paths.tmpPackageDir(token), paths.packageDir(hex));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTEMPTY") return false;
    throw error;
  }
  await syncDirectoryBestEffort(paths.sha256Root);
  return true;
}

/**
 * Commit one fully verified package into the immutable store. The caller MUST
 * hold the project lock. An already-resolvable digest converges without a second
 * rename; otherwise capacity is enforced, a fresh temp tree is staged, re-verified,
 * fsynced, and atomically renamed into its digest-derived path.
 */
export async function commitProductPackage(
  root: string, manifest: ProductPackageManifestV1, bytesByHex: ReadonlyMap<string, Buffer>,
): Promise<ProductPackageCommitResult> {
  return commitProductPackageWith(diskProductPackageCommitStore(root), manifest, bytesByHex);
}

/**
 * {@link commitProductPackage} over {@link ProductPackageCommitStore}: THE ONE BODY.
 * Convergence is checked BEFORE capacity; the canonical manifest bytes are made
 * before the capacity check and the random token; then stage, re-verify, sync,
 * rename, and on a collision converge ONLY onto a valid package; cleanup always.
 */
export async function commitProductPackageWith(
  store: ProductPackageCommitStore, manifest: ProductPackageManifestV1, bytesByHex: ReadonlyMap<string, Buffer>,
): Promise<ProductPackageCommitResult> {
  if ((await store.readInstalled(manifest.packageDigest)).status === "ok") {
    return { status: "converged" };
  }
  const hex = digestDirectoryName(manifest.packageDigest);
  const manifestBytes = canonicalBytes(manifest);
  const incoming = incomingBytes(manifest, manifestBytes);
  assertMeasuredCapacity(await store.measure(), incoming);
  const token = randomBytes(TEMP_TOKEN_BYTES).toString("hex");
  const staging = store.staging(token);
  try {
    await buildTempTree(staging, manifest, bytesByHex, manifestBytes);
    await reverifyTempTree(staging, manifest);
    await staging.sync();
    if (await staging.renameInto(hex)) return { status: "committed" };
    // The rename collided with an existing digest directory. It may converge ONLY
    // if that directory already resolves to the same valid package; a colliding
    // invalid or partial tree is a failure, never a silent convergence.
    if ((await store.readInstalled(manifest.packageDigest)).status !== "ok") {
      throw new ProductPackageError("a colliding package directory does not resolve to a valid package");
    }
    return { status: "converged" };
  } finally {
    await staging.cleanup();
  }
}
