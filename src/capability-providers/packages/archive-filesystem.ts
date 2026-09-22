/**
 * @file src/capability-providers/packages/archive-filesystem.ts
 * @description No-follow provider-tree extraction, verification, and portable
 * path admission. Directory handles remain open across each path-based access
 * so a swapped cache pathname cannot authorize provider bytes.
 */
import { validateProviderArchivePath } from "./archive-path.js";
export { validateProviderArchivePath } from "./archive-path.js";
import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  chmod, lstat, mkdir, open, opendir, realpath, type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import {
  MAX_EXPANDED_PACKAGE_TREE_BYTES, MAX_PACKAGE_ENTRIES, MAX_PACKAGE_ENTRY_BYTES,
} from "../constants.js";
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import {
  assertPathMatchesHandle, identity, openDirectoryNoFollow, sameIdentity,
} from "../../profile/templates/publish/distribution-paths.js";
import type { PlatformArtifactV1 } from "./protocol.js";


export interface ProviderTreeEntry {
  readonly relative: string;
  readonly body: Buffer;
}

export interface ProviderTreeSummary {
  readonly expandedTreeDigest: string;
  readonly expandedByteCount: number;
  readonly entryCount: number;
}

export interface ProviderTreeWriteOptions {
  readonly afterParentCheckForTest?: (directory: string) => Promise<void>;
  readonly afterLeafOpenForTest?: (leaf: string) => Promise<void>;
  readonly expectedParentReal?: string;
}

/** Verification constraints supplied by the package-custody authority. */
export interface ProviderTreeVerificationOptions {
  readonly expectedRootReal?: string;
  readonly maximumExpandedBytesForTest?: number;
  readonly maximumFilesystemEntriesForTest?: number;
  readonly afterFileStatForTest?: (leaf: string) => Promise<void>;
}

interface TreeRecord { readonly path: string; readonly digest: string; readonly byteCount: number }
interface BoundDirectory {
  readonly path: string;
  readonly real: string;
  readonly handle: FileHandle;
  readonly opened: ReturnType<typeof identity>;
}
interface TreeWalkState {
  readonly records: TreeRecord[];
  readonly directories: Set<string>;
  readonly options: ProviderTreeVerificationOptions;
  readonly maximumBytes: number;
  readonly maximumEntries: number;
  readonly bodies: Map<string, Buffer> | null;
  entries: number;
  reservedBytes: number;
}


/** Extract admitted regular files through bound parents and durable modes. */
export async function writeProviderTree(
  destination: string,
  entries: readonly ProviderTreeEntry[],
  entrypoint: string,
  options: ProviderTreeWriteOptions,
): Promise<void> {
  const parent = await bindDirectory(path.dirname(destination), options.expectedParentReal);
  let root: BoundDirectory | undefined;
  try {
    await assertDirectoryBound(parent);
    await mkdir(destination, { recursive: true, mode: 0o700 });
    await assertDirectoryBound(parent);
    root = await bindDirectory(destination, path.join(parent.real, path.basename(destination)));
    await options.afterParentCheckForTest?.(destination);
    await assertDirectoryBound(root);
    for (const entry of entries) await writeEntry(destination, root, entry, options);
    await assertDirectoryBound(root);
    await freezeTree(destination, entries, entrypoint, root);
  } finally {
    await root?.handle.close().catch(() => {});
    await parent.handle.close().catch(() => {});
  }
}

/** Rewalk an installed tree without following its root, parents, or leaves. */
export async function verifyProviderTreeOnDisk(
  root: string,
  artifact: PlatformArtifactV1,
  options: ProviderTreeVerificationOptions = {},
): Promise<ProviderTreeSummary> {
  const binding = await bindDirectory(root, options.expectedRootReal);
  const state = treeWalkState(options);
  try {
    await walkTree(root, "", binding.real, state, binding);
  } finally {
    await binding.handle.close().catch(() => {});
  }
  return finalizeTreeSummary(state, artifact);
}

/**
 * Enumerate an installed tree through held root/parent handles and return every
 * regular file's bytes, having recomputed the expanded-tree digest and compared
 * it plus the entrypoint against the pinned artifact. Callers copy the returned
 * entries into an invocation-private launch snapshot; a swapped cache tree or a
 * hard-link-swapped leaf changes the recomputed digest and is refused here.
 */
export async function readProviderTreeEntriesOnDisk(
  root: string,
  artifact: PlatformArtifactV1,
  options: ProviderTreeVerificationOptions = {},
): Promise<{ readonly entries: readonly ProviderTreeEntry[]; readonly summary: ProviderTreeSummary }> {
  const binding = await bindDirectory(root, options.expectedRootReal);
  const state = treeWalkState(options, true);
  try {
    await walkTree(root, "", binding.real, state, binding);
  } finally {
    await binding.handle.close().catch(() => {});
  }
  const summary = finalizeTreeSummary(state, artifact);
  const entries = [...state.records].sort(compareRecord).map((record) => Object.freeze({
    relative: record.path, body: state.bodies!.get(record.path)!,
  }));
  return Object.freeze({ entries: Object.freeze(entries), summary });
}

/** Verify the walked records against the pinned artifact and return the summary. */
function finalizeTreeSummary(state: TreeWalkState, artifact: PlatformArtifactV1): ProviderTreeSummary {
  const records = state.records;
  assertExactDirectoryShape(records, state.directories);
  const bytes = records.reduce((sum, item) => sum + item.byteCount, 0);
  const digest = canonicalDigest([...records].sort(compareRecord));
  if (records.length !== artifact.entryCount || bytes !== artifact.expandedByteCount
    || digest !== artifact.expandedTreeDigest
    || !records.some((item) => item.path === artifact.entrypointRelativePath)) {
    throw new Error("provider package tree differs from signed metadata");
  }
  return Object.freeze({ expandedTreeDigest: digest, expandedByteCount: bytes, entryCount: records.length });
}

async function writeEntry(
  destination: string,
  root: BoundDirectory,
  entry: ProviderTreeEntry,
  options: ProviderTreeWriteOptions,
): Promise<void> {
  const leaf = path.join(destination, ...entry.relative.split("/"));
  const parent = await bindEntryParent(root, entry.relative);
  const handle = await open(leaf, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await options.afterLeafOpenForTest?.(leaf);
    await assertFileBound(handle, leaf, parent);
    await handle.writeFile(entry.body); await handle.sync();
    await assertFileBound(handle, leaf, parent);
  } finally {
    await handle.close();
    if (parent !== root) await parent.handle.close().catch(() => {});
  }
}

async function bindEntryParent(root: BoundDirectory, relative: string): Promise<BoundDirectory> {
  const components = relative.split("/").slice(0, -1);
  let current = root;
  try {
    for (const component of components) {
      const nextPath = path.join(current.path, component);
      await assertDirectoryBound(current);
      await createDirectoryLeaf(nextPath);
      await assertDirectoryBound(current);
      const next = await bindDirectory(nextPath, path.join(current.real, component));
      if (current !== root) await current.handle.close();
      current = next;
    }
    return current;
  } catch (error) {
    if (current !== root) await current.handle.close().catch(() => {});
    throw error;
  }
}

async function createDirectoryLeaf(directory: string): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function walkTree(
  root: string,
  relative: string,
  canonicalRoot: string,
  state: TreeWalkState,
  retained?: BoundDirectory,
): Promise<void> {
  const directory = relative ? path.join(root, ...relative.split("/")) : root;
  const expected = relative ? path.join(canonicalRoot, ...relative.split("/")) : canonicalRoot;
  const binding = retained ?? await bindDirectory(directory, expected);
  try {
    await assertDirectoryBound(binding);
    const children = await opendir(directory);
    for await (const child of children) {
      await walkChild(root, relative, canonicalRoot, binding, child.name, state);
    }
    await assertDirectoryBound(binding);
  } finally {
    if (!retained) await binding.handle.close().catch(() => {});
  }
}

async function walkChild(
  root: string,
  relative: string,
  canonicalRoot: string,
  binding: BoundDirectory,
  childName: string,
  state: TreeWalkState,
): Promise<void> {
  reserveFilesystemEntry(state);
  const next = relative ? `${relative}/${childName}` : childName;
  validateInstalledPath(next);
  const leaf = path.join(root, ...next.split("/"));
  const entry = await lstat(leaf);
  if (entry.isSymbolicLink()) throw new Error("provider package tree contains a link");
  if (entry.isDirectory()) {
    state.directories.add(next);
    await walkTree(root, next, canonicalRoot, state);
  } else if (entry.isFile()) {
    state.records.push(await readTreeRecord(leaf, next, binding, state));
  } else throw new Error("provider package tree contains an unsupported leaf");
}

async function readTreeRecord(
  leaf: string,
  relative: string,
  parent: BoundDirectory,
  state: TreeWalkState,
): Promise<TreeRecord> {
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(leaf, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_PACKAGE_ENTRY_BYTES) throw new Error("provider package tree leaf is invalid");
    reserveTreeBytes(state, before.size);
    await assertFileBound(handle, leaf, parent, before);
    await state.options.afterFileStatForTest?.(leaf);
    const record = await readBoundedTreeRecord(handle, relative, before.size, state);
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      throw new Error("provider package tree changed while reading");
    }
    await assertFileBound(handle, leaf, parent, after);
    return record;
  } finally {
    await handle.close();
  }
}

async function readBoundedTreeRecord(
  handle: FileHandle,
  relative: string,
  expectedBytes: number,
  state: TreeWalkState,
): Promise<TreeRecord> {
  const hash = createHash("sha256");
  const collected = state.bodies !== null ? Buffer.allocUnsafe(expectedBytes) : null;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position <= expectedBytes) {
    const requested = Math.min(buffer.length, expectedBytes - position + 1);
    const { bytesRead } = await handle.read(buffer, 0, requested, position);
    if (bytesRead === 0) break;
    if (collected !== null && position + bytesRead <= expectedBytes) buffer.copy(collected, position, 0, bytesRead);
    position += bytesRead;
    if (position > expectedBytes) throw new Error("provider package tree changed while reading");
    hash.update(buffer.subarray(0, bytesRead));
  }
  if (position !== expectedBytes) throw new Error("provider package tree changed while reading");
  if (collected !== null) state.bodies!.set(relative, collected);
  return { path: relative, digest: `sha256:${hash.digest("hex")}`, byteCount: position };
}

async function freezeTree(
  destination: string,
  entries: readonly ProviderTreeEntry[],
  entrypoint: string,
  root: BoundDirectory,
): Promise<void> {
  if (process.platform === "win32") return;
  const directories = new Set<string>([destination]);
  for (const entry of entries) {
    const leaf = path.join(destination, ...entry.relative.split("/"));
    await assertDirectoryBound(root);
    await chmod(leaf, entry.relative === entrypoint ? 0o500 : 0o400);
    await syncFile(leaf);
    addParents(directories, destination, leaf);
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    await chmod(directory, 0o500); await syncDirectory(directory);
  }
  await assertDirectoryBound(root);
}

function addParents(directories: Set<string>, destination: string, leaf: string): void {
  for (let parent = path.dirname(leaf); parent.startsWith(destination); parent = path.dirname(parent)) {
    directories.add(parent);
    if (parent === destination) break;
  }
}

async function bindDirectory(directory: string, expectedReal?: string): Promise<BoundDirectory> {
  let handle: FileHandle;
  try {
    handle = await openDirectoryNoFollow(directory);
  } catch {
    throw new Error("provider package root or directory is unavailable");
  }
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory()) throw new Error("provider directory binding is unavailable");
    await assertPathMatchesHandle(directory, opened, "provider directory");
    const real = await realpath(directory);
    if (expectedReal !== undefined && real !== expectedReal) throw new Error("provider directory escaped its root");
    return { path: directory, real, handle, opened: identity(opened) };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function assertDirectoryBound(directory: BoundDirectory): Promise<void> {
  const opened = await directory.handle.stat();
  const real = await realpath(directory.path).catch(() => null);
  if (!opened.isDirectory() || !sameIdentity(identity(opened), directory.opened)
    || real !== directory.real) {
    throw new Error("provider directory changed during package access");
  }
  await assertPathMatchesHandle(directory.path, opened, "provider directory");
}

async function assertFileBound(
  handle: FileHandle,
  leaf: string,
  parent: BoundDirectory,
  opened?: Stats,
): Promise<void> {
  await assertDirectoryBound(parent);
  const handleStat = opened ?? await handle.stat();
  const current = await lstat(leaf);
  if (!handleStat.isFile() || !current.isFile() || current.isSymbolicLink()
    || !sameIdentity(identity(handleStat), identity(current))) {
    throw new Error("provider package leaf changed or escaped its parent");
  }
}

async function syncFile(leaf: string): Promise<void> {
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(leaf, fsConstants.O_RDONLY | noFollow);
  try {
    const entry = await handle.stat();
    if (!entry.isFile()) throw new Error("provider package leaf is unavailable");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await openDirectoryNoFollow(directory);
  try {
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "EPERM", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally {
    await handle.close();
  }
}

function validateInstalledPath(relative: string): void {
  const parts = validateProviderArchivePath(`package/${relative}`);
  if (parts.slice(1).join("/") !== relative.normalize("NFC")) {
    throw new Error("provider package tree path is non-canonical");
  }
}

function treeWalkState(options: ProviderTreeVerificationOptions, collectBodies = false): TreeWalkState {
  return {
    records: [], directories: new Set(), options,
    maximumBytes: testCeiling(options.maximumExpandedBytesForTest, MAX_EXPANDED_PACKAGE_TREE_BYTES),
    maximumEntries: testCeiling(options.maximumFilesystemEntriesForTest, MAX_PACKAGE_ENTRIES),
    bodies: collectBodies ? new Map<string, Buffer>() : null,
    entries: 0, reservedBytes: 0,
  };
}

function testCeiling(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error("provider verification test ceiling is invalid");
  }
  return value;
}

function reserveFilesystemEntry(state: TreeWalkState): void {
  state.entries += 1;
  if (state.entries > state.maximumEntries) throw new Error("provider package tree exceeds its entry cap");
}

function reserveTreeBytes(state: TreeWalkState, bytes: number): void {
  const next = state.reservedBytes + bytes;
  if (!Number.isSafeInteger(next) || next > state.maximumBytes) {
    throw new Error("provider package tree exceeds its expanded byte cap");
  }
  state.reservedBytes = next;
}

function assertExactDirectoryShape(records: readonly TreeRecord[], observed: ReadonlySet<string>): void {
  const implied = new Set<string>();
  for (const record of records) {
    for (let parent = path.posix.dirname(record.path); parent !== "."; parent = path.posix.dirname(parent)) {
      implied.add(parent);
    }
  }
  if (implied.size !== observed.size || [...observed].some((directory) => !implied.has(directory))) {
    throw new Error("provider package tree differs from signed metadata");
  }
}

function compareRecord(left: TreeRecord, right: TreeRecord): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}
