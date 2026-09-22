/**
 * @file Internal strict-durability support for atomic writes.
 * @description Captures and continuously verifies directory identities while
 * durable atomic publication syncs the leaf directory through a confined
 * project root. This module deliberately exposes only implementation-level
 * helpers used by `atomic-write.ts`; package consumers continue to use that
 * module's established public surface.
 */

import { lstat, open, realpath } from "fs/promises";
import { constants as fsConstants } from "node:fs";
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

/** Directory pathname and inode captured before its strict metadata sync. */
interface DirectoryBinding {
  dir: string;
  realDir: string;
  dev: number;
  ino: number;
}

/** Test-only observation or failure seam before a strict directory fsync. */
export type BeforeDirectorySync = (dir: string) => Promise<void>;

/** Strictly fsync one existing directory for durable non-file metadata changes. */
// Reserved for Foundation Task 5 catalog/projection durability.
// fallow-ignore-next-line unused-export
export async function fsyncDirectory(dir: string): Promise<void> {
  await fsyncBoundDirectory(await captureDirectoryBinding(dir));
}

/** Persist every directory entry from the leaf parent through the project root. */
export async function fsyncDirectoryChain(
  dir: string,
  parent?: ParentBinding,
  beforeSync?: BeforeDirectorySync,
): Promise<void> {
  const boundary = path.resolve(parent?.lexicalRoot ?? dir);
  let current = path.resolve(dir);
  for (;;) {
    await fsyncDirectoryChainEntry(canonicalSyncPath(current, parent), current, parent, beforeSync);
    if (current === boundary) return;
    const ancestor = nextDirectoryInChain(current, boundary);
    if (ancestor === null) return;
    current = ancestor;
  }
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

/** Sync one chain entry while the write parent remains continuously bound. */
async function fsyncDirectoryChainEntry(
  current: string,
  displayPath: string,
  parent?: ParentBinding,
  beforeSync?: BeforeDirectorySync,
): Promise<void> {
  await recheckWriteParent(parent);
  const binding = await captureDirectoryBinding(current);
  await recheckWriteParent(parent);
  await beforeSync?.(displayPath);
  await fsyncBoundDirectory(binding);
  await recheckWriteParent(parent);
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

/** Capture one non-symlink directory before any test seam or sync occurs. */
async function captureDirectoryBinding(dir: string): Promise<DirectoryBinding> {
  const resolved = path.resolve(dir);
  const stat = await lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`refusing to sync a redirected directory: ${resolved}`);
  }
  return { dir: resolved, realDir: await realpath(resolved), dev: stat.dev, ino: stat.ino };
}

/** Sync only the exact directory inode captured for this pathname. */
async function fsyncBoundDirectory(binding: DirectoryBinding): Promise<void> {
  await assertDirectoryBinding(binding);
  const handle = await open(binding.dir, DIRECTORY_OPEN_FLAGS);
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || opened.dev !== binding.dev || opened.ino !== binding.ino) {
      throw new Error(`directory changed before sync: ${binding.dir}`);
    }
    await assertDirectoryBinding(binding);
    await handle.sync();
    await assertDirectoryBinding(binding);
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
