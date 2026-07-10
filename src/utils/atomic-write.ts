/**
 * @file src/utils/atomic-write.ts
 * @description Shared atomic file writer with confined-parent symlink and
 * parent-swap defenses for project writes.
 */

import { rename, mkdir, lstat, open, unlink, realpath } from "fs/promises";
import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "path";
import { confineUnderRoot, isInsideDir } from "./path-confine.js";

/** Bytes of randomness in the per-write temp-file suffix (16 hex chars). */
const TEMP_SUFFIX_BYTES = 8;

/** Options for {@link atomicWrite}. */
export interface AtomicWriteOptions {
  /**
   * When provided, confine the write under this project root: the nearest
   * existing ancestor of `filePath` must realpath-resolve inside `confineRoot`
   * before any directory is created, and the opened temp must remain bound to
   * the same checked parent before bytes are written.
   */
  confineRoot?: string;
  /** Opt-in power-loss durability: fsync temp data before rename and parent after rename. */
  durable?: boolean;
  /** Optional POSIX permission bits for the created temp file. */
  mode?: number;
  /** Test-only hook for deterministic parent-swap race coverage. */
  afterParentCheckForTest?: () => Promise<void>;
}

interface ParentBinding {
  dir: string;
  realRoot: string;
  realDir: string;
  dev: number;
  ino: number;
}

/** Atomically write a file through a random O_EXCL temp and rename. */
export async function atomicWrite(
  filePath: string,
  content: string,
  opts?: AtomicWriteOptions,
): Promise<void> {
  const dir = path.dirname(filePath);
  if (opts?.confineRoot !== undefined) {
    await assertAncestorInRoot(filePath, opts.confineRoot);
  }
  await mkdir(dir, { recursive: true });
  const binding = await assertParentNotSymlink(dir, opts?.confineRoot);
  await opts?.afterParentCheckForTest?.();
  await writeViaTemp(filePath, content, opts?.durable === true, opts?.mode, binding);
}

/** Best-effort directory fsync after a durable rename. */
async function fsyncDir(dir: string): Promise<void> {
  let dirHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    dirHandle = await open(dir, "r");
    await dirHandle.sync();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EPERM" && code !== "ENOTSUP") throw err;
  } finally {
    await dirHandle?.close().catch(() => {});
  }
}

/** Fail closed before mkdir when the nearest existing ancestor escapes root. */
async function assertAncestorInRoot(filePath: string, confineRoot: string): Promise<void> {
  const relPath = path.relative(confineRoot, filePath);
  await confineUnderRoot(relPath, confineRoot, { mustExist: false });
}

/** Reject a symlinked parent and capture its identity for later binding checks. */
async function assertParentNotSymlink(dir: string, confineRoot?: string): Promise<ParentBinding | undefined> {
  const dirStat = await lstat(dir);
  if (dirStat.isSymbolicLink()) {
    throw new Error(`refusing to write through a symlinked directory: ${dir}`);
  }
  if (confineRoot === undefined) return undefined;
  const realRoot = await realpath(confineRoot);
  const realDir = await realpath(dir);
  if (!isInsideDir(realDir, realRoot)) {
    throw new Error(`write directory escapes project root: ${dir}`);
  }
  return { dir, realRoot, realDir, dev: dirStat.dev, ino: dirStat.ino };
}

/** Write content only after the opened temp handle is bound to the checked parent. */
async function writeViaTemp(
  filePath: string,
  content: string,
  durable: boolean,
  mode?: number,
  binding?: ParentBinding,
): Promise<void> {
  const tmpPath = `${filePath}.${randomBytes(TEMP_SUFFIX_BYTES).toString("hex")}.tmp`;
  const handle = mode === undefined ? await open(tmpPath, "wx") : await open(tmpPath, "wx", mode);
  try {
    await assertTempHandleBound(handle, tmpPath, binding);
    await handle.writeFile(content, "utf-8");
    if (durable) await handle.sync();
    const tempStat = await assertTempHandleBound(handle, tmpPath, binding);
    await handle.close();
    await assertTempPathBound(tmpPath, binding, tempStat);
    await rename(tmpPath, filePath);
    if (durable) await fsyncDir(path.dirname(filePath));
  } catch (err) {
    await handle.close().catch(() => {});
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/** Verify the current parent directory is still the same confined directory. */
async function assertCurrentParent(binding: ParentBinding): Promise<void> {
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

/** Verify the open temp handle and temp path resolve to the same file. */
async function assertTempHandleBound(
  handle: FileHandle,
  tmpPath: string,
  binding: ParentBinding | undefined,
): Promise<Stats | undefined> {
  if (!binding) return undefined;
  await assertCurrentParent(binding);
  const handleStat = await handle.stat();
  await assertTempPathBound(tmpPath, binding, handleStat);
  return handleStat;
}

/** Verify the temp path still refers to the expected in-parent inode. */
async function assertTempPathBound(
  tmpPath: string,
  binding: ParentBinding | undefined,
  expected: Stats | undefined,
): Promise<void> {
  if (!binding || !expected) return;
  await assertCurrentParent(binding);
  const pathStat = await lstat(tmpPath);
  if (pathStat.dev !== expected.dev || pathStat.ino !== expected.ino) {
    throw new Error(`temporary write handle is not bound to the confined path: ${tmpPath}`);
  }
}
