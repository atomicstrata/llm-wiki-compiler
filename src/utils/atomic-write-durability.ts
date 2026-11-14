/**
 * @file Internal strict-durability support for atomic writes.
 * @description Captures and continuously verifies directory identities while
 * durable atomic publication syncs the leaf directory through a confined
 * project root. This module deliberately exposes only implementation-level
 * helpers used by `atomic-write.ts`; package consumers continue to use that
 * module's established public surface.
 */

import { open } from "fs/promises";
import { lstat, realpath } from "./fs-metadata.js";
import { constants as fsConstants, type Stats } from "node:fs";
import path from "path";
import { isInsideDir } from "./path-confine.js";

/** Refuse to follow a directory leaf while obtaining its sync handle. */
const DIRECTORY_OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;

/** Identity of the confined write parent captured before a temp is created. */
export interface ParentBinding {
  dir: string;
  lexicalRoot: string;
  realRoot: string;
  realDir: string;
  dev: number;
  ino: number;
}

interface DirectoryBinding {
  dir: string;
  realDir: string;
  dev: number;
  ino: number;
  parentBound: boolean;
}

/** Test-only observation or failure seam before a strict directory fsync. */
export type BeforeDirectorySync = (dir: string) => Promise<void>;

/** Strictly fsync one existing directory for durable non-file metadata changes. */
// Reserved for Foundation Task 5 catalog/projection durability.
// fallow-ignore-next-line unused-export
export async function fsyncDirectory(dir: string): Promise<void> {
  await fsyncBoundDirectory(await captureDirectoryBinding(dir));
}

/** Persist the leaf parent's directory entry, then every ancestor entry up to the project root, and confirm the write parent is still the bound directory. */
export async function fsyncDirectoryChain(
  dir: string,
  parent?: ParentBinding,
  beforeSync?: BeforeDirectorySync,
): Promise<void> {
  await syncChain(dir, parent, beforeSync, true);
}

/** {@link fsyncDirectoryChain} for a caller whose very next step checks the write parent itself (`assertCurrentParent`, directly or as the first step of `assertPublishedDestination`, `assertSettledDestination` or `removeCommittedTemp`), so the chain leaves out its own check after the last sync. */
export async function fsyncDirectoryChainBeforeParentCheck(
  dir: string,
  parent: ParentBinding | undefined,
  beforeSync?: BeforeDirectorySync,
): Promise<void> {
  await syncChain(dir, parent, beforeSync, false);
}

/**
 * Ancestor entries this process has made durable: `parent identity>child
 * identity@child name`, to the parent's modification and change times when it
 * was synced. Each entry answers for ONE hop only, so the walk always continues
 * to the boundary: an ancestor above a failed sync, or above an earlier, lower
 * boundary, has no entry and is synced. A parent whose times moved since may
 * have had the child's entry removed and re-created, so it is synced again.
 */
const durableEntries = new Map<string, string>();

/** One directory object's identity, or `null` on a filesystem with no birth time to tell a reused inode apart. */
function directoryIdentity(stat: Stats): string | null {
  return stat.birthtimeMs === 0 ? null : `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

function childEntry(directory: Stats, dir: string): string | null {
  const identity = directoryIdentity(directory);
  return identity === null ? null : `${identity}@${path.basename(dir)}`;
}

function durableEntryKey(parent: Stats, child: string | null): string | null {
  const identity = directoryIdentity(parent);
  return identity === null || child === null ? null : `${identity}>${child}`;
}

function changeTimes(stat: Stats): string {
  return `${stat.mtimeMs}:${stat.ctimeMs}`;
}

/** Sync `ancestor` unless it is known to still hold `below` durably; its stat either way. */
async function syncAncestor(
  ancestor: string, below: string | null, parent: ParentBinding | undefined, beforeSync: BeforeDirectorySync | undefined,
): Promise<Stats> {
  const canonical = canonicalSyncPath(ancestor, parent);
  const seen = await lstat(canonical);
  const known = durableEntryKey(seen, below);
  if (known !== null && durableEntries.get(known) === changeTimes(seen)) return seen;
  await beforeSync?.(ancestor);
  const synced = await fsyncBoundDirectory(await captureDirectoryBinding(canonical, seen));
  const key = durableEntryKey(synced, below);
  if (key !== null) durableEntries.set(key, changeTimes(synced));
  return synced;
}

async function syncChain(
  dir: string,
  parent: ParentBinding | undefined,
  beforeSync: BeforeDirectorySync | undefined,
  checkLast: boolean,
): Promise<void> {
  const boundary = path.resolve(parent?.lexicalRoot ?? dir);
  let current = path.resolve(dir);
  await beforeSync?.(current);
  let below = childEntry(await fsyncBoundDirectory(await chainStart(current, parent)), current);
  for (;;) {
    const next = current === boundary ? null : nextDirectoryInChain(current, boundary);
    if (next !== null || checkLast) await recheckWriteParent(parent);
    if (next === null) return;
    below = childEntry(await syncAncestor(next, below, parent, beforeSync), next);
    current = next;
  }
}

async function chainStart(current: string, parent: ParentBinding | undefined): Promise<DirectoryBinding> {
  const canonical = canonicalSyncPath(current, parent);
  if (parent === undefined || path.resolve(parent.dir) !== current || canonical !== parent.realDir) {
    return captureDirectoryBinding(canonical);
  }
  return { dir: canonical, realDir: parent.realDir, dev: parent.dev, ino: parent.ino, parentBound: true };
}

/** Verify the current parent directory is still the captured confined directory. */
export async function assertCurrentParent(binding: ParentBinding): Promise<void> {
  const stat = await lstat(binding.dir);
  if (stat.isSymbolicLink()) throw new Error(`refusing to write through a symlinked directory: ${binding.dir}`);
  const realDir = await realpath(binding.dir);
  if (realDir !== binding.realDir || !isInsideDir(realDir, binding.realRoot)) {
    throw new Error(`write directory changed or escapes project root: ${binding.dir}`);
  }
  if (stat.dev !== binding.dev || stat.ino !== binding.ino) {
    throw new Error(`write directory changed while writing: ${binding.dir}`);
  }
}

/** Map a lexical project directory onto the already-bound canonical root. */
function canonicalSyncPath(current: string, parent?: ParentBinding): string {
  if (parent === undefined) return current;
  return path.join(parent.realRoot, path.relative(parent.lexicalRoot, current));
}

/** Recheck a confined write parent when strict publication captured one. */
async function recheckWriteParent(parent?: ParentBinding): Promise<void> {
  if (parent !== undefined) await assertCurrentParent(parent);
}

/** Return the next containing directory without crossing the sync boundary. */
function nextDirectoryInChain(current: string, boundary: string): string | null {
  const ancestor = path.dirname(current);
  return ancestor !== current && isInsideDir(ancestor, boundary) ? ancestor : null;
}

async function captureDirectoryBinding(dir: string, known?: Stats): Promise<DirectoryBinding> {
  const resolved = path.resolve(dir);
  const stat = known ?? await lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`refusing to sync a redirected directory: ${resolved}`);
  }
  return { dir: resolved, realDir: await realpath(resolved), dev: stat.dev, ino: stat.ino, parentBound: false };
}

/** Sync the bound directory; returns its `fstat`, taken before the sync. */
async function fsyncBoundDirectory(binding: DirectoryBinding): Promise<Stats> {
  const handle = await open(binding.dir, DIRECTORY_OPEN_FLAGS);
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || opened.dev !== binding.dev || opened.ino !== binding.ino) {
      throw new Error(`directory changed before sync: ${binding.dir}`);
    }
    await handle.sync();
    if (!binding.parentBound) await assertDirectoryBinding(binding);
    return opened;
  } finally {
    await handle.close();
  }
}

/** Recheck that a directory pathname still names its captured inode. */
async function assertDirectoryBinding(binding: DirectoryBinding): Promise<void> {
  const stat = await lstat(binding.dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      stat.dev !== binding.dev || stat.ino !== binding.ino ||
      await realpath(binding.dir) !== binding.realDir) {
    throw new Error(`directory changed while syncing: ${binding.dir}`);
  }
}
