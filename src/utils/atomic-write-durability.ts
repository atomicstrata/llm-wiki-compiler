/**
 * @file Internal strict-durability support for atomic writes.
 * @description Captures and continuously verifies directory identities while
 * durable atomic publication syncs the leaf directory through a confined
 * project root. This module deliberately exposes only implementation-level
 * helpers used by `atomic-write.ts`; package consumers continue to use that
 * module's established public surface.
 */

import { randomUUID } from "node:crypto";
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

/**
 * Directory pathname and inode captured before its strict metadata sync.
 * `parentBound` marks the write parent itself, taken from its
 * {@link ParentBinding} rather than captured again (see {@link chainStart}).
 */
interface DirectoryBinding {
  dir: string;
  realDir: string;
  dev: number;
  ino: number;
  parentBound: boolean;
}

/**
 * Directory entries this process has already made durable, as
 * `parent identity > child identity`.
 *
 * A write changes one directory: the leaf's parent. That directory is always
 * synced. An ancestor's entry for the directory below it changes only when
 * that directory is created, and once the ancestor has been synced with the
 * child in place, the entry stays durable for as long as both objects live.
 * So the walk up the chain stops at the first ancestor already known to hold
 * its child durably, instead of re-syncing every directory up to the project
 * root on every write.
 *
 * IDENTITY, NOT PATH. A directory swapped for another, or deleted and
 * recreated, is a different object and is synced again.
 */
const durableEntries = new Set<string>();

/**
 * One directory object's identity; the birth time tells a reused inode apart.
 * A filesystem that reports no birth time cannot tell them apart, so each such
 * directory gets an identity that never matches again: it is always synced.
 */
function directoryIdentity(stat: { dev: number; ino: number; birthtimeMs: number }): string {
  if (stat.birthtimeMs === 0) return `unidentified:${randomUUID()}`;
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

/**
 * Lstat the next ancestor once: `null` when it is already known to hold
 * `child`'s entry durably (the walk stops), else the stat its sync binds to.
 */
async function ancestorNeedingSync(ancestor: string, child: string): Promise<Stats | null> {
  const stat = await lstat(ancestor);
  return durableEntries.has(`${directoryIdentity(stat)}>${child}`) ? null : stat;
}

/** Test-only observation or failure seam before a strict directory fsync. */
export type BeforeDirectorySync = (dir: string) => Promise<void>;

/** Strictly fsync one existing directory for durable non-file metadata changes. */
// Reserved for Foundation Task 5 catalog/projection durability.
// fallow-ignore-next-line unused-export
export async function fsyncDirectory(dir: string): Promise<void> {
  await fsyncBoundDirectory(await captureDirectoryBinding(dir));
}

/**
 * Persist the leaf parent's directory entry, then every ancestor entry up to
 * the project root that is not already durable (see {@link durableEntries}),
 * and confirm the write parent is still the bound directory.
 */
export async function fsyncDirectoryChain(
  dir: string,
  parent?: ParentBinding,
  beforeSync?: BeforeDirectorySync,
): Promise<void> {
  await syncChain(dir, parent, beforeSync, true);
}

/**
 * {@link fsyncDirectoryChain} for a caller whose very next step checks the
 * write parent itself (`assertCurrentParent`, directly or as the first step of
 * `assertPublishedDestination`, `assertSettledDestination` or
 * `removeCommittedTemp`), so the chain leaves out its own check after the last
 * sync. The chain makes no namespace change, so that one check covers every
 * swap the chain's own last check would have caught; a second one right
 * before it would only repeat it.
 */
export async function fsyncDirectoryChainBeforeParentCheck(
  dir: string,
  parent: ParentBinding | undefined,
  beforeSync?: BeforeDirectorySync,
): Promise<void> {
  await syncChain(dir, parent, beforeSync, false);
}

/** Walk and sync the chain; `checkLast` keeps the parent check after the last sync. */
async function syncChain(
  dir: string,
  parent: ParentBinding | undefined,
  beforeSync: BeforeDirectorySync | undefined,
  checkLast: boolean,
): Promise<void> {
  const boundary = path.resolve(parent?.lexicalRoot ?? dir);
  let current = path.resolve(dir);
  let binding = await chainStart(current, parent);
  let below: string | undefined;
  for (;;) {
    await beforeSync?.(current);
    const identity = await fsyncBoundDirectory(binding);
    if (below !== undefined) durableEntries.add(`${identity}>${below}`);
    const next = await nextChainEntry(current, boundary, parent, identity);
    if (next !== null || checkLast) await recheckWriteParent(parent);
    if (next === null) return;
    binding = await captureDirectoryBinding(canonicalSyncPath(next.dir, parent), next.stat);
    below = identity;
    current = next.dir;
  }
}

/** The next ancestor the chain must sync, with its stat, or `null` where the walk stops. */
async function nextChainEntry(
  current: string,
  boundary: string,
  parent: ParentBinding | undefined,
  identity: string,
): Promise<{ dir: string; stat: Stats } | null> {
  const ancestor = current === boundary ? null : nextDirectoryInChain(current, boundary);
  if (ancestor === null) return null;
  const stat = await ancestorNeedingSync(canonicalSyncPath(ancestor, parent), identity);
  return stat === null ? null : { dir: ancestor, stat };
}

/**
 * The first directory the chain syncs. When it is the bound write parent at
 * its canonical path, the parent binding already names its inode, so it is
 * not captured again: the sync handle is pinned to the parent's inode, and the
 * parent check after the sync (the chain's own, or the caller's) proves the
 * canonical path still names it, since `realpath(parent) === realDir` and
 * `realDir` is that canonical path.
 */
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

/**
 * Capture one non-symlink directory before any test seam or sync occurs,
 * reusing `known` when the caller has just lstat'd the same path.
 */
async function captureDirectoryBinding(dir: string, known?: Stats): Promise<DirectoryBinding> {
  const resolved = path.resolve(dir);
  const stat = known ?? await lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`refusing to sync a redirected directory: ${resolved}`);
  }
  return { dir: resolved, realDir: await realpath(resolved), dev: stat.dev, ino: stat.ino, parentBound: false };
}

/**
 * Sync only the exact directory inode captured for this pathname, and return
 * that directory object's identity.
 *
 * The no-follow open plus the fstat comparison pins the handle to the captured
 * inode, so no later swap can redirect the fsync itself. The one pathname
 * check after the sync then proves the path still named that inode
 * throughout: everything between it and the capture is read-only, so a
 * pathname check before the sync would only repeat it. A parent-bound entry
 * leaves that check to the write-parent check that follows it.
 */
async function fsyncBoundDirectory(binding: DirectoryBinding): Promise<string> {
  const handle = await open(binding.dir, DIRECTORY_OPEN_FLAGS);
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || opened.dev !== binding.dev || opened.ino !== binding.ino) {
      throw new Error(`directory changed before sync: ${binding.dir}`);
    }
    await handle.sync();
    if (!binding.parentBound) await assertDirectoryBinding(binding);
    return directoryIdentity(opened);
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
