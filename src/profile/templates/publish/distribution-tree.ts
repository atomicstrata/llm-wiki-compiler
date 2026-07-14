/**
 * @file src/profile/templates/publish/distribution-tree.ts
 * @description Exact static-tree enumeration with retained inode and ctime
 * guards that remain live through the publisher verification verdict.
 */
import type { BigIntStats, Stats } from "node:fs";
import { opendir, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { openConfinedLeaf } from "../../../utils/confined-read.js";
import { sha256DigestHex } from "../signing/protocol.js";
import {
  assertPathMatchesHandle,
  assertRootBound,
  openDirectoryNoFollow,
  type DistributionPaths,
} from "./distribution-paths.js";

type DirectoryMutationGuard = { handle: FileHandle; info: Stats; path: string; ctimeNs: bigint };
type AnchoredDirectory = { handle: FileHandle; info: Stats; ctimeNs: bigint };
type HeldDirectoryGuard = {
  directory: string;
  anchor: AnchoredDirectory;
  parent: DirectoryMutationGuard;
  label: string;
};

/** Retained exact-tree anchors that remain valid until explicitly closed. */
export interface DistributionTreeGuard {
  assertUnchanged(): Promise<void>;
  close(): Promise<void>;
}

/** Convert a signed digest to its only permitted distribution path. */
export function packagePath(paths: DistributionPaths, digest: string): string {
  return path.join(paths.packageDirectory, `${sha256DigestHex(digest)}.json`);
}

/** Assert one exact-tree snapshot while releasing its guards afterward. */
export async function assertExactDistributionTree(
  paths: DistributionPaths,
  digests: string[],
): Promise<void> {
  const guard = await openExactDistributionTreeGuard(paths, digests);
  await guard.close();
}

/** Enumerate the exact tree and retain every directory mutation guard. */
export async function openExactDistributionTreeGuard(
  paths: DistributionPaths,
  digests: string[],
): Promise<DistributionTreeGuard> {
  const filenames = digests.map((digest) => path.basename(packagePath(paths, digest)));
  if (new Set(filenames).size !== filenames.length) {
    throw new Error("duplicate signed entries alias the same package path");
  }
  const held: HeldDirectoryGuard[] = [];
  try {
    await inspectDistributionTree(paths, filenames, held);
    await assertHeldDirectoriesUnchanged(paths, held);
    return retainedGuard(paths, held);
  } catch (error) {
    await closeHeldDirectories(held);
    throw error;
  }
}

async function inspectDistributionTree(
  paths: DistributionPaths,
  filenames: string[],
  held: HeldDirectoryGuard[],
): Promise<void> {
  await holdCheckedDirectory(paths, paths.root, ["index.json", "packages"], "distribution root", held);
  await assertRegularLeaf(paths, path.join(paths.root, "index.json"), paths.root, "index");
  const packages = path.join(paths.root, "packages");
  await holdCheckedDirectory(paths, packages, ["sha256"], "packages directory", held);
  for (const filename of filenames) {
    await assertRegularLeaf(paths, path.join(paths.packageDirectory, filename), paths.packageDirectory, "package");
  }
  await holdCheckedDirectory(paths, paths.packageDirectory, filenames, "package digest directory", held);
}

async function holdCheckedDirectory(
  paths: DistributionPaths,
  directory: string,
  expectedNames: string[],
  label: string,
  held: HeldDirectoryGuard[],
): Promise<void> {
  const anchor = await openAnchoredDirectory(paths, directory, label);
  let parent: DirectoryMutationGuard | undefined;
  try {
    parent = await openDirectoryMutationGuard(paths, directory, label);
    const seen = await scanDirectory(paths, directory, anchor, parent, label, new Set(expectedNames));
    if (seen.size !== expectedNames.length) throw new Error("distribution contains a missing entry");
    held.push({ directory, anchor, parent, label });
  } catch (error) {
    await parent?.handle.close().catch(() => {});
    await anchor.handle.close().catch(() => {});
    throw error;
  }
}

function retainedGuard(paths: DistributionPaths, held: HeldDirectoryGuard[]): DistributionTreeGuard {
  let isClosed = false;
  return {
    assertUnchanged: async () => {
      if (isClosed) throw new Error("distribution tree guard is closed");
      await assertHeldDirectoriesUnchanged(paths, held);
    },
    close: async () => {
      if (isClosed) return;
      isClosed = true;
      await closeHeldDirectories(held);
    },
  };
}

async function assertHeldDirectoriesUnchanged(
  paths: DistributionPaths,
  held: HeldDirectoryGuard[],
): Promise<void> {
  for (const guard of held) {
    await assertDirectoryStillBound(paths, guard.directory, guard.anchor, guard.parent, guard.label);
  }
}

async function closeHeldDirectories(held: HeldDirectoryGuard[]): Promise<void> {
  await Promise.all(held.flatMap(({ anchor, parent }) => [
    parent.handle.close().catch(() => {}),
    anchor.handle.close().catch(() => {}),
  ]));
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
    if (isIntentionalTreeError(error)) throw error;
    throw new Error("distribution contains a missing, unreadable, or unexpected directory");
  } finally {
    await stream?.close().catch(() => {});
  }
}

function isIntentionalTreeError(error: unknown): error is Error {
  return error instanceof Error && (
    error.message.startsWith("distribution contains")
    || error.message.includes("changed during enumeration")
  );
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
  const canonical = path.join(paths.canonicalRoot, path.relative(paths.root, directory));
  const parentPath = path.dirname(canonical);
  const handle = await openDirectoryNoFollow(parentPath).catch(() => null);
  if (!handle) throw new Error(`${label} parent cannot be anchored for enumeration`);
  try {
    const [info, precise] = await Promise.all([handle.stat(), handle.stat({ bigint: true })]);
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
  const [info, precise] = await Promise.all([
    handle.stat().catch(() => null),
    handle.stat({ bigint: true }).catch(() => null),
  ]);
  if (!info?.isDirectory() || !precise?.isDirectory()) {
    await handle.close().catch(() => {});
    throw new Error(`${label} must be a non-symlink directory`);
  }
  return bindAnchoredDirectory(paths, directory, label, handle, info, precise.ctimeNs);
}

async function bindAnchoredDirectory(
  paths: DistributionPaths,
  directory: string,
  label: string,
  handle: FileHandle,
  info: Stats,
  ctimeNs: bigint,
): Promise<AnchoredDirectory> {
  const canonical = await realpath(directory).catch(() => null);
  const expected = path.join(paths.canonicalRoot, path.relative(paths.root, directory));
  try {
    if (canonical !== expected) throw new Error(`${label} is symlinked or escapes confinement`);
    await assertPathMatchesHandle(directory, info, label);
    await assertPathMatchesHandle(canonical, info, label);
    return { handle, info, ctimeNs };
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
  if (opened.kind !== "confirmed") {
    throw new Error(`${label} is missing or not a regular file and may not be a symlink`);
  }
  await opened.handle.close().catch(() => {});
  await assertRootBound(paths);
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
  const [current, currentParent] = await Promise.all([
    opened.handle.stat({ bigint: true }).catch(() => null),
    parent.handle.stat({ bigint: true }).catch(() => null),
  ]) as [BigIntStats | null, BigIntStats | null];
  assertDirectoryCtimes(current, currentParent, opened, parent, label);
}

function assertDirectoryCtimes(
  current: BigIntStats | null,
  currentParent: BigIntStats | null,
  opened: AnchoredDirectory,
  parent: DirectoryMutationGuard,
  label: string,
): void {
  if (!current?.isDirectory() || current.ctimeNs !== opened.ctimeNs) {
    throw new Error(`${label} changed during enumeration`);
  }
  if (!currentParent?.isDirectory() || currentParent.ctimeNs !== parent.ctimeNs) {
    throw new Error(`${label} parent changed during enumeration`);
  }
}
