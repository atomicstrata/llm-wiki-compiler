/**
 * @file src/profile/templates/publish/filesystem.ts
 * @description Read-only filesystem boundary for offline publisher snapshots.
 * It accepts only the fixed static distribution layout, rejects symlinks and
 * special files, binds reads to confined open handles, caps every input with a
 * bounded read that resists concurrent growth, and decodes signed protocol
 * bytes as strict UTF-8.
 */
import { constants as fsConstants, type BigIntStats, type Stats } from "node:fs";
import { lstat, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import { TextDecoder } from "node:util";
import path from "node:path";
import { openConfinedLeaf } from "../../../utils/confined-read.js";
import { sha256DigestHex } from "../signing/protocol.js";

const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
const MAX_KEY_BYTES = 16 * 1024;
/** Canonical base64 with correct padding; no ignored characters or trailing bytes. */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Canonical paths for a snapshot whose root passed the no-symlink gate. */
export interface DistributionPaths {
  root: string;
  canonicalRoot: string;
  packageDirectory: string;
  rootHandle: FileHandle;
  rootIdentity: FileIdentity;
  testSeams: DistributionResolveOptions;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

type DirectoryMutationGuard = { handle: FileHandle; info: Stats; path: string; ctimeNs: bigint };
type AnchoredDirectory = { handle: FileHandle; info: Stats; ctimeNs: bigint };

export interface DistributionResolveOptions {
  /** Test-only seam for a deterministic root replacement after open. */
  afterRootOpenForTest?: () => Promise<void>;
  /** Test-only seams for a deterministic swap around pathname-based opendir. */
  beforeDirectoryStreamOpenForTest?: (directory: string, label: string) => Promise<void>;
  afterDirectoryStreamOpenForTest?: (directory: string, label: string) => Promise<void>;
}

/** Open and retain a no-follow handle that binds all later reads to one root inode. */
export async function resolveDistributionPaths(
  directory: string,
  options: DistributionResolveOptions = {},
): Promise<DistributionPaths> {
  const root = path.resolve(directory);
  let rootHandle: FileHandle | undefined;
  try {
    rootHandle = await openDirectoryNoFollow(root);
    const opened = await rootHandle.stat();
    if (!opened.isDirectory()) throw new Error("distribution root must be a non-symlink directory");
    if (options.afterRootOpenForTest) await options.afterRootOpenForTest();
    const canonicalRoot = await realpath(root).catch(() => null);
    if (!canonicalRoot) throw new Error("distribution root cannot be confined");
    await assertPathMatchesHandle(root, opened, "distribution root");
    await assertPathMatchesHandle(canonicalRoot, opened, "distribution root");
    return {
      root,
      canonicalRoot,
      packageDirectory: path.join(root, "packages", "sha256"),
      rootHandle,
      rootIdentity: identity(opened),
      testSeams: options,
    };
  } catch (error) {
    await rootHandle?.close().catch(() => {});
    throw error instanceof Error ? error : new Error("distribution root cannot be confined");
  }
}

/** Release the retained root inode after verification finishes. */
export async function closeDistributionPaths(paths: DistributionPaths): Promise<void> {
  await paths.rootHandle.close().catch(() => {});
}

/** One tap-key selection retained for the complete verification transaction. */
export interface SelectedTapPublicKey {
  read(): Promise<string>;
  close(): Promise<void>;
}

/** Anchor the selected key leaf and canonical parent before reading trust-root bytes. */
export async function openTapPublicKey(file: string): Promise<SelectedTapPublicKey> {
  const selected = path.resolve(file);
  const leaf = await lstat(selected).catch(() => null);
  if (!leaf || leaf.isSymbolicLink()) {
    throw new Error("tap key file is unavailable, symlinked, or special");
  }
  const canonical = await realpath(selected).catch(() => null);
  if (!canonical) throw new Error("tap key file is unavailable, symlinked, or special");
  const parentPath = path.dirname(canonical);
  const parentHandle = await openDirectoryNoFollow(parentPath).catch(() => null);
  if (!parentHandle) throw new Error("tap key parent cannot be anchored");
  let handle: FileHandle | undefined;
  try {
    const parentInfo = await parentHandle.stat();
    if (!parentInfo.isDirectory()) throw new Error("tap key parent cannot be anchored");
    handle = await open(
      canonical,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("tap key file must be a regular file and not a symlink or special file");
    await assertSelectedTapKey(selected, canonical, parentPath, parentInfo, handle, info);
    return {
      read: async () => {
        await assertSelectedTapKey(selected, canonical, parentPath, parentInfo, handle!, info);
        const bytes = await readBoundedFromHandle(handle!, MAX_KEY_BYTES, "tap key file");
        await assertSelectedTapKey(selected, canonical, parentPath, parentInfo, handle!, info);
        return keyFileText(decodeUtf8(bytes, "tap key file"));
      },
      close: async () => {
        await handle?.close().catch(() => {});
        handle = undefined;
        await parentHandle.close().catch(() => {});
      },
    };
  } catch (error) {
    await handle?.close().catch(() => {});
    await parentHandle.close().catch(() => {});
    throw error;
  }
}

async function assertSelectedTapKey(
  selected: string,
  canonical: string,
  parentPath: string,
  parentInfo: Stats,
  handle: FileHandle,
  info: Stats,
): Promise<void> {
  if (await realpath(selected).catch(() => null) !== canonical) {
    throw new Error("tap key selected path changed during verification");
  }
  const current = await handle.stat().catch(() => null);
  if (!current?.isFile() || !sameIdentity(identity(current), identity(info))) {
    throw new Error("tap key handle changed during verification");
  }
  await assertPathMatchesHandle(parentPath, parentInfo, "tap key parent");
  await assertPathMatchesHandle(canonical, info, "tap key file");
}

/** Strictly decode a base64 SPKI DER key with no ignored characters or trailing bytes. */
export function decodeCanonicalBase64Key(text: string, label: string): Buffer {
  if (text.length === 0 || !CANONICAL_BASE64.test(text)) {
    throw new Error(`${label} must be canonical base64 with no ignored characters`);
  }
  const decoded = Buffer.from(text, "base64");
  if (decoded.toString("base64") !== text) {
    throw new Error(`${label} contains non-canonical base64 padding or trailing bytes`);
  }
  return decoded;
}

function keyFileText(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

/** Read the fixed index leaf through a root-anchored, handle-bound open. */
export async function readDistributionIndex(paths: DistributionPaths): Promise<string> {
  await assertRootBound(paths);
  const result = await readConfinedUtf8(paths.root, path.join(paths.root, "index.json"), paths.root, MAX_INDEX_BYTES, "index");
  await assertRootBound(paths);
  return result;
}

/** Convert a signed digest to its only permitted content-addressed path. */
function packagePath(paths: DistributionPaths, digest: string): string {
  const hex = sha256DigestHex(digest);
  return path.join(paths.packageDirectory, `${hex}.json`);
}

/** Read one digest-derived package without following any path component. */
export async function readDistributionPackage(paths: DistributionPaths, digest: string): Promise<string> {
  await assertRootBound(paths);
  const result = await readConfinedUtf8(
    paths.root,
    packagePath(paths, digest),
    paths.packageDirectory,
    MAX_PACKAGE_BYTES,
    "package",
  );
  await assertRootBound(paths);
  return result;
}

/** Require the complete static tree to contain exactly the signed package paths. */
export async function assertExactDistributionTree(paths: DistributionPaths, digests: string[]): Promise<void> {
  const filenames = digests.map((digest) => path.basename(packagePath(paths, digest)));
  if (new Set(filenames).size !== filenames.length) throw new Error("duplicate signed entries alias the same package path");
  await assertDirectory(paths, paths.root, ["index.json", "packages"], "distribution root");
  await assertRegularLeaf(paths, path.join(paths.root, "index.json"), paths.root, "index");
  const packages = path.join(paths.root, "packages");
  await assertDirectory(paths, packages, ["sha256"], "packages directory");
  for (const filename of filenames) {
    await assertRegularLeaf(paths, path.join(paths.packageDirectory, filename), paths.packageDirectory, "package");
  }
  await assertDirectory(paths, paths.packageDirectory, filenames, "package digest directory");
  await assertRootBound(paths);
}

/** Stream at most the signed expected entry count plus one while an inode anchor is held. */
async function assertDirectory(
  paths: DistributionPaths,
  directory: string,
  expectedNames: string[],
  label: string,
): Promise<void> {
  const anchor = await openAnchoredDirectory(paths, directory, label);
  const parent = await openDirectoryMutationGuard(paths, directory, label);
  try {
    const seen = await scanDirectory(
      paths,
      directory,
      anchor,
      parent,
      label,
      new Set(expectedNames),
    );
    if (seen.size !== expectedNames.length) throw new Error("distribution contains a missing entry");
  } finally {
    await parent.handle.close().catch(() => {});
    await anchor.handle.close().catch(() => {});
  }
}

async function scanDirectory(
  paths: DistributionPaths,
  directory: string,
  anchor: AnchoredDirectory,
  parent: DirectoryMutationGuard,
  label: string,
  expected: Set<string>,
): Promise<Set<string>> {
  let stream: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    await assertDirectoryStillBound(paths, directory, anchor, parent, label);
    if (paths.testSeams.beforeDirectoryStreamOpenForTest) {
      await paths.testSeams.beforeDirectoryStreamOpenForTest(directory, label);
    }
    stream = await opendir(directory);
    if (paths.testSeams.afterDirectoryStreamOpenForTest) {
      await paths.testSeams.afterDirectoryStreamOpenForTest(directory, label);
    }
    return await readExpectedEntries(paths, directory, anchor, parent, label, stream, expected);
  } catch (error) {
    if (error instanceof Error && (
      error.message.startsWith("distribution contains")
      || error.message.includes("changed during enumeration")
    )) throw error;
    throw new Error("distribution contains a missing, unreadable, or unexpected directory");
  } finally {
    await stream?.close().catch(() => {});
  }
}

async function readExpectedEntries(
  paths: DistributionPaths,
  directory: string,
  anchor: AnchoredDirectory,
  parent: DirectoryMutationGuard,
  label: string,
  stream: Awaited<ReturnType<typeof opendir>>,
  expected: Set<string>,
): Promise<Set<string>> {
  const seen = new Set<string>();
  for (;;) {
    await assertDirectoryStillBound(paths, directory, anchor, parent, label);
    const entry = await stream.read();
    await assertDirectoryStillBound(paths, directory, anchor, parent, label);
    if (entry === null) return seen;
    recordExpectedEntry(entry.name, expected, seen);
  }
}

async function openDirectoryMutationGuard(
  paths: DistributionPaths,
  directory: string,
  label: string,
): Promise<DirectoryMutationGuard> {
  const canonicalDirectory = path.join(
    paths.canonicalRoot,
    path.relative(paths.root, directory),
  );
  const parentPath = path.dirname(canonicalDirectory);
  const handle = await openDirectoryNoFollow(parentPath).catch(() => null);
  if (!handle) throw new Error(`${label} parent cannot be anchored for enumeration`);
  try {
    const [info, precise] = await Promise.all([
      handle.stat(),
      handle.stat({ bigint: true }),
    ]);
    if (!info.isDirectory() || !precise.isDirectory()) {
      throw new Error(`${label} parent cannot be anchored for enumeration`);
    }
    await assertPathMatchesHandle(parentPath, info, `${label} parent`);
    return { handle, info, path: parentPath, ctimeNs: precise.ctimeNs };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function recordExpectedEntry(name: string, expected: Set<string>, seen: Set<string>): void {
  if (!expected.has(name) || seen.has(name) || seen.size >= expected.size) {
    throw new Error("distribution contains an extra, unreferenced, or unexpected entry");
  }
  seen.add(name);
}

async function openAnchoredDirectory(
  paths: DistributionPaths,
  directory: string,
  label: string,
): Promise<AnchoredDirectory> {
  await assertRootBound(paths);
  const handle = await openDirectoryNoFollow(directory).catch(() => null);
  if (!handle) throw new Error(`${label} must be a non-symlink directory`);
  const [info, precise] = await Promise.all(
    [handle.stat().catch(() => null), handle.stat({ bigint: true }).catch(() => null)],
  );
  if (!info?.isDirectory() || !precise?.isDirectory()) {
    await handle.close().catch(() => {});
    throw new Error(`${label} must be a non-symlink directory`);
  }
  const canonical = await realpath(directory).catch(() => null);
  const expected = path.join(paths.canonicalRoot, path.relative(paths.root, directory));
  if (canonical !== expected) {
    await handle.close().catch(() => {});
    throw new Error(`${label} is symlinked or escapes confinement`);
  }
  try {
    await assertPathMatchesHandle(directory, info, label);
    await assertPathMatchesHandle(canonical, info, label);
    return { handle, info, ctimeNs: precise.ctimeNs };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function assertRegularLeaf(
  paths: DistributionPaths,
  file: string,
  expectedDirectory: string,
  label: string,
): Promise<void> {
  await assertRootBound(paths);
  const opened = await openConfinedLeaf(paths.root, file, expectedDirectory);
  if (opened.kind !== "confirmed") throw new Error(`${label} is missing or not a regular file and may not be a symlink`);
  await opened.handle.close().catch(() => {});
  await assertRootBound(paths);
}

async function openDirectoryNoFollow(directory: string): Promise<FileHandle> {
  return open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | fsConstants.O_DIRECTORY);
}

async function assertDirectoryStillBound(
  paths: DistributionPaths,
  directory: string,
  opened: AnchoredDirectory,
  parent: DirectoryMutationGuard,
  label: string,
): Promise<void> {
  await assertRootBound(paths);
  await assertPathMatchesHandle(directory, opened.info, label);
  await assertPathMatchesHandle(parent.path, parent.info, `${label} parent`);
  const [current, currentParent] = await Promise.all(
    [opened.handle.stat({ bigint: true }).catch(() => null), parent.handle.stat({ bigint: true }).catch(() => null)],
  ) as [BigIntStats | null, BigIntStats | null];
  if (!current?.isDirectory() || current.ctimeNs !== opened.ctimeNs) {
    throw new Error(`${label} changed during enumeration`);
  }
  if (!currentParent?.isDirectory() || currentParent.ctimeNs !== parent.ctimeNs) {
    throw new Error(`${label} parent changed during enumeration`);
  }
}

async function assertRootBound(paths: DistributionPaths): Promise<void> {
  const opened = await paths.rootHandle.stat().catch(() => null);
  if (!opened?.isDirectory() || !sameIdentity(identity(opened), paths.rootIdentity)) {
    throw new Error("distribution root handle is unavailable or changed");
  }
  const canonical = await realpath(paths.root).catch(() => null);
  if (canonical !== paths.canonicalRoot) throw new Error("distribution root changed during verification");
  await assertPathMatchesHandle(paths.root, opened, "distribution root");
}

async function assertPathMatchesHandle(file: string, opened: Stats, label: string): Promise<void> {
  const current = await lstat(file).catch(() => null);
  if (!current || current.isSymbolicLink() || !sameIdentity(identity(current), identity(opened))) {
    throw new Error(`${label} is symlinked, escaped, or changed during verification`);
  }
}

function identity(info: Stats): FileIdentity {
  return { dev: info.dev, ino: info.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readConfinedUtf8(
  root: string,
  file: string,
  expectedDirectory: string,
  maxBytes: number,
  label: string,
): Promise<string> {
  const opened = await openConfinedLeaf(root, file, expectedDirectory);
  if (opened.kind !== "confirmed") throw new Error(`${label} is missing, symlinked, or not a regular file`);
  try {
    if (opened.size > maxBytes) throw new Error(`${label} exceeds its bounded size limit`);
    return decodeUtf8(await readBoundedFromHandle(opened.handle, maxBytes, label), label);
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/**
 * Read at most `maxBytes` bytes from an already-confirmed regular-file handle,
 * rejecting a file that grew past the cap between the fstat gate and the read.
 * Reading `maxBytes + 1` and refusing a full buffer closes the size-check/read
 * race a concurrently growing file would otherwise open.
 */
async function readBoundedFromHandle(handle: FileHandle, maxBytes: number, label: string): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total > maxBytes) throw new Error(`${label} exceeds its bounded size limit`);
  return buffer.subarray(0, total);
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}
