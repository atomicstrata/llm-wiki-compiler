/**
 * @file src/profile/templates/publish/distribution-paths.ts
 * @description Retained root identity and canonical path binding for offline
 * publisher distribution reads and directory enumeration.
 */
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

interface FileIdentity {
  dev: number;
  ino: number;
}

/** Test seams for deterministic filesystem race regression coverage. */
export interface DistributionResolveOptions {
  afterRootOpenForTest?: () => Promise<void>;
  beforeDirectoryStreamOpenForTest?: (directory: string, label: string) => Promise<void>;
  afterDirectoryStreamOpenForTest?: (directory: string, label: string) => Promise<void>;
  beforeLeafOpenForTest?: (file: string, label: string) => Promise<void>;
  afterLeafOpenForTest?: (file: string, label: string) => Promise<void>;
}

/** Canonical paths and the retained inode selected for one verification. */
export interface DistributionPaths {
  root: string;
  canonicalRoot: string;
  packageDirectory: string;
  rootHandle: FileHandle;
  rootIdentity: FileIdentity;
  testSeams: DistributionResolveOptions;
}

/** Resolve and retain a no-follow directory handle for the selected root. */
export async function resolveDistributionPaths(
  directory: string,
  options: DistributionResolveOptions = {},
): Promise<DistributionPaths> {
  const root = path.resolve(directory);
  let rootHandle: FileHandle | undefined;
  try {
    rootHandle = await openDirectoryNoFollow(root).catch(() => undefined);
    if (!rootHandle) throw new Error("distribution root is unavailable or cannot be confined");
    const opened = await rootHandle.stat();
    if (!opened.isDirectory()) throw new Error("distribution root must be a non-symlink directory");
    if (options.afterRootOpenForTest) await options.afterRootOpenForTest();
    const canonicalRoot = await realpath(root).catch(() => null);
    if (!canonicalRoot) throw new Error("distribution root cannot be confined");
    await assertPathMatchesHandle(root, opened, "distribution root");
    await assertPathMatchesHandle(canonicalRoot, opened, "distribution root");
    return distributionPaths(root, canonicalRoot, rootHandle, opened, options);
  } catch (error) {
    await rootHandle?.close().catch(() => {});
    if (error instanceof Error && error.message.startsWith("distribution root")) throw error;
    throw new Error("distribution root cannot be confined");
  }
}

function distributionPaths(
  root: string,
  canonicalRoot: string,
  rootHandle: FileHandle,
  opened: Stats,
  testSeams: DistributionResolveOptions,
): DistributionPaths {
  return {
    root,
    canonicalRoot,
    packageDirectory: path.join(root, "packages", "sha256"),
    rootHandle,
    rootIdentity: identity(opened),
    testSeams,
  };
}

/** Close the retained root handle after the verification transaction. */
export async function closeDistributionPaths(paths: DistributionPaths): Promise<void> {
  await paths.rootHandle.close().catch(() => {});
}

/** Prove the selected pathname still names the retained root inode. */
export async function assertRootBound(paths: DistributionPaths): Promise<void> {
  const opened = await paths.rootHandle.stat().catch(() => null);
  if (!opened?.isDirectory() || !sameIdentity(identity(opened), paths.rootIdentity)) {
    throw new Error("distribution root handle is unavailable or changed");
  }
  const canonical = await realpath(paths.root).catch(() => null);
  if (canonical !== paths.canonicalRoot) throw new Error("distribution root changed during verification");
  await assertPathMatchesHandle(paths.root, opened, "distribution root");
}

/** Require a no-follow pathname to retain the identity of an open handle. */
export async function assertPathMatchesHandle(file: string, opened: Stats, label: string): Promise<void> {
  const current = await lstat(file).catch(() => null);
  if (!current || current.isSymbolicLink() || !sameIdentity(identity(current), identity(opened))) {
    throw new Error(`${label} is symlinked, escaped, or changed during verification`);
  }
}

/** Open a directory without following its final component or blocking. */
export async function openDirectoryNoFollow(directory: string): Promise<FileHandle> {
  return open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | fsConstants.O_DIRECTORY);
}

/** Capture portable filesystem identity fields from stat output. */
export function identity(info: Stats): FileIdentity {
  return { dev: info.dev, ino: info.ino };
}

/** Compare two captured filesystem identities. */
export function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
