/**
 * @file src/capability-providers/packages/local-snapshot.ts
 * @description Bounded, no-follow custody for local-development provider
 * sources. Retained directory handles bind every pathname read to the exact
 * selected root, while streamed traversal reserves counts and bytes before
 * materializing file contents.
 */
import { constants as fsConstants, type Dir, type Stats } from "node:fs";
import {
  lstat, open, opendir, realpath, type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import {
  MAX_EXPANDED_PACKAGE_TREE_BYTES, MAX_PACKAGE_ENTRIES, MAX_PACKAGE_ENTRY_BYTES,
} from "../constants.js";
import {
  assertPathMatchesHandle, identity, openDirectoryNoFollow, sameIdentity,
} from "../../profile/templates/publish/distribution-paths.js";
import {
  reserveExpandedProviderBytes, validateProviderArchivePath,
} from "./archive.js";
import type { ProviderTreeEntry } from "./archive-filesystem.js";

/** Test-only controls for deterministic source races and small cap fixtures. */
export interface LocalProviderSnapshotOptions {
  readonly maximumFilesystemEntriesForTest?: number;
  readonly maximumDirectoriesForTest?: number;
  readonly maximumExpandedBytesForTest?: number;
  readonly afterDirectoryStreamOpenForTest?: (
    directory: string, relative: string,
  ) => Promise<void>;
  readonly beforeFileOpenForTest?: (leaf: string) => Promise<void>;
  readonly afterFileStatForTest?: (leaf: string) => Promise<void>;
  readonly beforeFileReadForTest?: (leaf: string) => Promise<void>;
}

interface BoundSourceDirectory {
  readonly path: string;
  readonly real: string;
  readonly handle: FileHandle;
  readonly opened: ReturnType<typeof identity>;
}

interface SnapshotBudget {
  readonly maximumEntries: number;
  readonly maximumDirectories: number;
  readonly maximumBytes: number;
  entries: number;
  directories: number;
  bytes: number;
}

interface SnapshotContext {
  readonly files: ProviderTreeEntry[];
  readonly seen: Set<string>;
  readonly budget: SnapshotBudget;
  readonly options: LocalProviderSnapshotOptions;
}

/** Capture one immutable byte snapshot from the exact selected source root. */
export async function snapshotLocalProviderTree(
  sourceRoot: string,
  options: LocalProviderSnapshotOptions = {},
): Promise<readonly ProviderTreeEntry[]> {
  const root = await bindSourceRoot(sourceRoot);
  const context = snapshotContext(options);
  try {
    await walkSourceDirectory(root, "", context);
    await assertSourceDirectoryBound(root);
    return Object.freeze(context.files);
  } finally {
    await root.handle.close().catch(() => {});
  }
}

async function walkSourceDirectory(
  directory: BoundSourceDirectory,
  relative: string,
  context: SnapshotContext,
): Promise<void> {
  await assertSourceDirectoryBound(directory);
  const stream = await opendir(directory.path);
  try {
    await context.options.afterDirectoryStreamOpenForTest?.(directory.path, relative);
    await assertSourceDirectoryBound(directory);
    for await (const child of stream) {
      await collectSourceChild(directory, relative, child.name, context);
    }
    await assertSourceDirectoryBound(directory);
  } finally {
    await closeDirectoryStream(stream);
  }
}

async function collectSourceChild(
  parent: BoundSourceDirectory,
  relative: string,
  name: string,
  context: SnapshotContext,
): Promise<void> {
  reserveEntry(context.budget);
  const next = relative ? `${relative}/${name}` : name;
  const canonical = canonicalRelative(next);
  reserveUniquePath(context.seen, canonical);
  const leaf = path.join(parent.path, name);
  await assertSourceDirectoryBound(parent);
  const entry = await lstat(leaf);
  await assertSourceDirectoryBound(parent);
  if (entry.isSymbolicLink()) throw unsupportedLeafError();
  if (entry.isDirectory()) return collectSourceDirectory(parent, canonical, leaf, context);
  if (!entry.isFile()) throw unsupportedLeafError();
  context.files.push(await readLocalFile(parent, leaf, canonical, context));
}

async function collectSourceDirectory(
  parent: BoundSourceDirectory,
  relative: string,
  leaf: string,
  context: SnapshotContext,
): Promise<void> {
  reserveDirectory(context.budget);
  const directory = await bindSourceDirectory(leaf, parent);
  try {
    await walkSourceDirectory(directory, relative, context);
  } finally {
    await directory.handle.close().catch(() => {});
  }
}

async function readLocalFile(
  parent: BoundSourceDirectory,
  leaf: string,
  relative: string,
  context: SnapshotContext,
): Promise<ProviderTreeEntry> {
  await assertSourceDirectoryBound(parent);
  await context.options.beforeFileOpenForTest?.(leaf);
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(leaf, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | noFollow);
  try {
    const before = await handle.stat();
    assertAdmittedFile(before);
    await assertSourceFileBound(handle, leaf, parent);
    reserveBytes(context.budget, before.size);
    await context.options.afterFileStatForTest?.(leaf);
    await assertSourceFileBound(handle, leaf, parent);
    await context.options.beforeFileReadForTest?.(leaf);
    const body = await readExactBytesPlusOne(handle, before.size);
    const after = await handle.stat();
    assertFileUnchanged(before, after);
    await assertSourceFileBound(handle, leaf, parent);
    return { relative, body };
  } finally {
    await handle.close();
  }
}

async function readExactBytesPlusOne(handle: FileHandle, expectedBytes: number): Promise<Buffer> {
  const body = Buffer.allocUnsafe(expectedBytes);
  let position = 0;
  while (position < expectedBytes) {
    const { bytesRead } = await handle.read(body, position, expectedBytes - position, position);
    if (bytesRead === 0) throw sourceChangedError();
    position += bytesRead;
  }
  const overflow = Buffer.allocUnsafe(1);
  const { bytesRead } = await handle.read(overflow, 0, 1, expectedBytes);
  if (bytesRead !== 0) throw sourceChangedError();
  return body;
}

async function bindSourceRoot(sourceRoot: string): Promise<BoundSourceDirectory> {
  if (typeof sourceRoot !== "string" || sourceRoot.length === 0) throw sourceRootError();
  return bindSourceDirectory(path.resolve(sourceRoot));
}

async function bindSourceDirectory(
  directory: string,
  parent?: BoundSourceDirectory,
): Promise<BoundSourceDirectory> {
  if (parent) await assertSourceDirectoryBound(parent);
  const handle = await openDirectoryNoFollow(directory).catch(() => null);
  if (!handle) throw sourceRootError();
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory()) throw sourceRootError();
    const real = await realpath(directory);
    if (parent && real !== path.join(parent.real, path.basename(directory))) throw sourceRootError();
    await assertPathMatchesHandle(directory, opened, "local provider source directory");
    if (parent) await assertSourceDirectoryBound(parent);
    return { path: directory, real, handle, opened: identity(opened) };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function assertSourceDirectoryBound(directory: BoundSourceDirectory): Promise<void> {
  const opened = await directory.handle.stat().catch(() => null);
  const currentReal = await realpath(directory.path).catch(() => null);
  if (!opened?.isDirectory() || !sameIdentity(identity(opened), directory.opened)
    || currentReal !== directory.real) throw sourceChangedError();
  await assertPathMatchesHandle(directory.path, opened, "local provider source directory");
}

async function assertSourceFileBound(
  handle: FileHandle,
  leaf: string,
  parent: BoundSourceDirectory,
): Promise<void> {
  await assertSourceDirectoryBound(parent);
  const opened = await handle.stat();
  const current = await lstat(leaf);
  if (!opened.isFile() || !current.isFile() || current.isSymbolicLink()
    || opened.nlink !== 1 || current.nlink !== 1
    || !sameIdentity(identity(opened), identity(current))) throw sourceChangedError();
}

function snapshotContext(options: LocalProviderSnapshotOptions): SnapshotContext {
  const maximumEntries = testCeiling(options.maximumFilesystemEntriesForTest, MAX_PACKAGE_ENTRIES);
  const maximumDirectories = testCeiling(options.maximumDirectoriesForTest, MAX_PACKAGE_ENTRIES);
  const maximumBytes = testCeiling(
    options.maximumExpandedBytesForTest, MAX_EXPANDED_PACKAGE_TREE_BYTES,
  );
  return {
    files: [], seen: new Set(), options,
    budget: {
      maximumEntries, maximumDirectories, maximumBytes,
      entries: 0, directories: 0, bytes: 0,
    },
  };
}

function testCeiling(value: number | undefined, maximum: number): number {
  const selected = value ?? maximum;
  if (!Number.isSafeInteger(selected) || selected < 0 || selected > maximum) {
    throw new Error("local provider snapshot test ceiling is invalid");
  }
  return selected;
}

function reserveEntry(budget: SnapshotBudget): void {
  budget.entries += 1;
  if (budget.entries > budget.maximumEntries) throw new Error("local provider source exceeds its entry cap");
}

function reserveDirectory(budget: SnapshotBudget): void {
  budget.directories += 1;
  if (budget.directories > budget.maximumDirectories) {
    throw new Error("local provider source exceeds its directory cap");
  }
}

function reserveBytes(budget: SnapshotBudget, bytes: number): void {
  let next: number;
  try {
    next = reserveExpandedProviderBytes(budget.bytes, bytes);
  } catch {
    throw new Error("local provider source exceeds its expanded byte cap");
  }
  if (next > budget.maximumBytes) {
    throw new Error("local provider source exceeds its expanded byte cap");
  }
  budget.bytes = next;
}

function reserveUniquePath(seen: Set<string>, relative: string): void {
  const collision = relative.toLowerCase();
  if (seen.has(collision)) throw new Error("local provider source contains a path collision");
  seen.add(collision);
}

function canonicalRelative(relative: string): string {
  const parts = validateProviderArchivePath(`package/${relative}`);
  const result = parts.slice(1).join("/");
  if (result !== relative) throw new Error("local provider source path is non-canonical");
  return result;
}

function assertAdmittedFile(entry: Stats): void {
  if (!entry.isFile() || entry.size > MAX_PACKAGE_ENTRY_BYTES) {
    throw new Error("local provider file exceeds its byte cap");
  }
  if (entry.nlink !== 1) throw new Error("local provider source contains a hard-linked file");
}

function assertFileUnchanged(before: Stats, after: Stats): void {
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.nlink !== 1 || after.nlink !== 1 || before.nlink !== after.nlink) {
    throw sourceChangedError();
  }
}

async function closeDirectoryStream(stream: Dir): Promise<void> {
  await stream.close().catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") throw error;
  });
}

function unsupportedLeafError(): Error {
  return new Error("local provider source contains an unsupported leaf");
}

function sourceRootError(): Error {
  return new Error("local provider source must be an exact regular directory");
}

function sourceChangedError(): Error {
  return new Error("local provider source changed while snapshotting");
}
