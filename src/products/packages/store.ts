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
 */

import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { canonicalBytes } from "../../profile/templates/signing/canonical.js";
import { atomicWriteNoReplaceDurable } from "../../utils/atomic-write.js";
import { openConfinedLeaf, readConfinedLeafBuffer, type ConfinedLeafOpen } from "../../utils/confined-read.js";
import { streamConfinedDigest } from "../../utils/stream-digest.js";
import { isInsideDir } from "../../utils/path-confine.js";
import {
  MAX_INSTALLED_PACKAGES_PER_PROJECT, MAX_PRODUCT_MANIFEST_BYTES, MAX_PRODUCT_PACKAGE_STORE_BYTES,
} from "../constants.js";
import { assertProductDigest, digestDirectoryName, type Sha256Digest } from "../ids.js";
import { ProductBoundsError, ProductPackageError } from "../problems.js";
import { MANIFEST_FILENAME, MEMBERS_SEGMENT, productStorePaths, type ProductStorePaths } from "../paths.js";
import { loadProductPackageManifest } from "./verify.js";
import type { ProductPackageManifestV1 } from "../types.js";

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
const TEMP_TOKEN_BYTES = 16;
type ConfirmedLeaf = Extract<ConfinedLeafOpen, { kind: "confirmed" }>;

/** Complete read classification for one installed immutable package. */
export type InstalledPackageRead =
  | { status: "ok"; manifest: ProductPackageManifestV1 }
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

/** Best-effort directory fsync tolerating filesystems without the operation. */
async function fsyncDir(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOENT") throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Stream one confined member leaf and require it match its digest and size. */
async function streamVerifyMember(opened: ConfirmedLeaf, hex: string, byteCount: number): Promise<boolean> {
  try {
    if (opened.size !== byteCount) return false;
    const streamed = await streamConfinedDigest(opened, byteCount);
    if (streamed === null || streamed.total !== byteCount) return false;
    const after = await opened.handle.stat();
    const stable = after.dev === opened.dev && after.ino === opened.ino
      && after.nlink === opened.nlink && after.size === opened.size;
    return stable && streamed.digest === hex;
  } catch {
    return false;
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/** The outcome of proving every member leaf beneath one package tree. */
type MemberLeavesOutcome = "ok" | { status: "invalid" | "unavailable"; detail: string };

/** Verify every declared member leaf under a members root, digest by digest. */
async function verifyMemberLeaves(
  root: string, membersRoot: string, memberFile: (hex: string) => string,
  manifest: ProductPackageManifestV1,
): Promise<MemberLeavesOutcome> {
  for (const member of manifest.members) {
    const hex = digestDirectoryName(member.digest);
    const opened = await openConfinedLeaf(root, memberFile(hex), membersRoot, { requireSingleLink: true });
    if (opened.kind === "absent") return { status: "invalid", detail: "member-absent" };
    if (opened.kind !== "confirmed") return { status: "unavailable", detail: "member-leaf" };
    if (!(await streamVerifyMember(opened, hex, member.byteCount))) return { status: "invalid", detail: "member-bytes" };
  }
  return "ok";
}

/**
 * Read a real (non-symlinked) directory's entries, or classify the failure. Both
 * the stat AND the enumeration are caught: a denied `readdir` (an execute-only
 * directory, EACCES) is an `unavailable` classification, never a thrown error
 * that escapes the read-result contract into a caller's read or activation path.
 */
async function readRealDir(dir: string): Promise<Dirent[] | { status: "unavailable"; detail: string }> {
  const stat = await lstat(dir).catch(() => null);
  if (stat === null) return { status: "unavailable", detail: "dir-absent" };
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { status: "unavailable", detail: "dir-not-real" };
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return { status: "unavailable", detail: "dir-unreadable" };
  }
}

/** Whether one package-root entry is the declared manifest file or members directory. */
function isDeclaredPackageEntry(entry: Dirent): boolean {
  return (entry.name === MANIFEST_FILENAME && entry.isFile())
    || (entry.name === MEMBERS_SEGMENT && entry.isDirectory());
}

/**
 * Reject any leaf the manifest does not declare (section 7.6 unknown-leaves fail
 * closed): the package directory must hold EXACTLY the manifest and the members
 * directory, and members/ EXACTLY the declared member digest files. An undeclared
 * file, directory, or member — the bytes an attacker would plant — keeps the
 * package unresolved rather than accepted as `ok`.
 */
async function assertNoUndeclaredLeaves(
  packageDir: string, membersRoot: string, manifest: ProductPackageManifestV1,
): Promise<MemberLeavesOutcome> {
  const pkg = await readRealDir(packageDir);
  if (!Array.isArray(pkg)) return pkg;
  if (pkg.some((entry) => !isDeclaredPackageEntry(entry))) return { status: "invalid", detail: "undeclared-package-leaf" };
  const members = await readRealDir(membersRoot);
  if (!Array.isArray(members)) return members;
  const declared = new Set(manifest.members.map((member) => digestDirectoryName(member.digest)));
  if (members.some((entry) => !entry.isFile() || !declared.has(entry.name))) {
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
  let hex: string;
  try {
    hex = digestDirectoryName(assertProductDigest(packageDigest));
  } catch {
    return { status: "unavailable", detail: "digest" };
  }
  const paths = productStorePaths(root);
  const read = await readConfinedLeafBuffer(
    root, paths.manifestFile(hex), paths.packageDir(hex), MAX_PRODUCT_MANIFEST_BYTES, { requireSingleLink: true });
  if (read.kind === "absent") return { status: "absent" };
  if (read.kind !== "ok") return { status: "unavailable", detail: "manifest-leaf" };
  let manifest: ProductPackageManifestV1;
  try {
    manifest = bindManifest(read.body, hex);
  } catch (error) {
    return { status: "invalid", detail: error instanceof Error ? error.message : "manifest-invalid" };
  }
  const members = await verifyMemberLeaves(root, paths.membersRoot(hex), (mh) => paths.memberFile(hex, mh), manifest);
  if (members !== "ok") return members;
  const undeclared = await assertNoUndeclaredLeaves(paths.packageDir(hex), paths.membersRoot(hex), manifest);
  return undeclared === "ok" ? { status: "ok", manifest } : undeclared;
}

/** Count installed package directories, tolerating an absent store root. */
async function countChildDirectories(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
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
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const full = `${current}/${entry.name}`;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) total += (await lstat(full)).size;
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
  const measured = await measureProductPackageStore(root);
  if (measured.installedCount + 1 > MAX_INSTALLED_PACKAGES_PER_PROJECT) {
    throw new ProductBoundsError("installed product packages per project");
  }
  if (measured.totalBytes + incoming > MAX_PRODUCT_PACKAGE_STORE_BYTES) {
    throw new ProductBoundsError("total product-package store bytes");
  }
}

/** Write one durable, confined, create-only leaf beneath the project temp tree. */
async function writeTempLeaf(root: string, file: string, bytes: Buffer): Promise<void> {
  await atomicWriteNoReplaceDurable(file, bytes, { confineRoot: root, exactParent: true, mode: 0o600 });
}

/** Stage the manifest and every member into a fresh project-private temp tree. */
async function buildTempTree(
  root: string, paths: ProductStorePaths, token: string,
  manifest: ProductPackageManifestV1, bytesByHex: ReadonlyMap<string, Buffer>, manifestBytes: Buffer,
): Promise<void> {
  await writeTempLeaf(root, paths.tmpManifestFile(token), manifestBytes);
  for (const member of manifest.members) {
    const hex = digestDirectoryName(member.digest);
    const bytes = bytesByHex.get(hex);
    if (bytes === undefined) throw new ProductPackageError("a member's bytes are missing while staging");
    await writeTempLeaf(root, paths.tmpMemberFile(token, hex), bytes);
  }
}

/** Re-verify the complete project-local staged bytes before the final rename. */
async function reverifyTempTree(
  root: string, paths: ProductStorePaths, token: string, manifest: ProductPackageManifestV1,
): Promise<void> {
  const read = await readConfinedLeafBuffer(
    root, paths.tmpManifestFile(token), paths.tmpPackageDir(token), MAX_PRODUCT_MANIFEST_BYTES,
    { requireSingleLink: true });
  if (read.kind !== "ok" || !canonicalBytes(manifest).equals(read.body)) {
    throw new ProductPackageError("staged manifest failed re-verification");
  }
  const members = await verifyMemberLeaves(
    root, paths.tmpMembersRoot(token), (hex) => paths.tmpMemberFile(token, hex), manifest);
  if (members !== "ok") throw new ProductPackageError("staged member bytes failed re-verification");
}

/** Create the store parent, refusing a symlinked or escaping directory. */
async function ensureRealDir(root: string, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  if ((await lstat(dir)).isSymbolicLink()) throw new ProductPackageError("store directory is a symlink");
  if (!isInsideDir(await realpath(dir), await realpath(root))) {
    throw new ProductPackageError("store directory escapes the project root");
  }
}

/** Atomically rename the staged tree into place, converging on an existing digest. */
async function renameIntoPlace(root: string, paths: ProductStorePaths, token: string, hex: string): Promise<boolean> {
  await ensureRealDir(root, paths.sha256Root);
  try {
    await rename(paths.tmpPackageDir(token), paths.packageDir(hex));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTEMPTY") return false;
    throw error;
  }
  await fsyncDir(paths.sha256Root);
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
  if ((await readInstalledProductPackage(root, manifest.packageDigest)).status === "ok") {
    return { status: "converged" };
  }
  const hex = digestDirectoryName(manifest.packageDigest);
  const manifestBytes = canonicalBytes(manifest);
  await assertProductStoreCapacity(root, incomingBytes(manifest, manifestBytes));
  const token = randomBytes(TEMP_TOKEN_BYTES).toString("hex");
  const paths = productStorePaths(root);
  try {
    await buildTempTree(root, paths, token, manifest, bytesByHex, manifestBytes);
    await reverifyTempTree(root, paths, token, manifest);
    await fsyncDir(paths.tmpMembersRoot(token));
    await fsyncDir(paths.tmpPackageDir(token));
    if (await renameIntoPlace(root, paths, token, hex)) return { status: "committed" };
    // The rename collided with an existing digest directory. It may converge ONLY
    // if that directory already resolves to the same valid package; a colliding
    // invalid or partial tree is a failure, never a silent convergence.
    if ((await readInstalledProductPackage(root, manifest.packageDigest)).status !== "ok") {
      throw new ProductPackageError("a colliding package directory does not resolve to a valid package");
    }
    return { status: "converged" };
  } finally {
    await rm(paths.tmpPackageDir(token), { recursive: true, force: true }).catch(() => {});
  }
}
