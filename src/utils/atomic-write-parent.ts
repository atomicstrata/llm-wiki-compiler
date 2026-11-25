/**
 * @file src/utils/atomic-write-parent.ts
 * @description Internal confinement and parent-binding helpers for the shared
 * atomic writers in `atomic-write.ts`: fail closed when a write's nearest
 * existing ancestor escapes (or, with `exactParent`, redirects from) the
 * confined project root before any `mkdir`, refuse a symlinked parent, and
 * capture the parent's canonical identity ({@link ParentBinding}) that every
 * later temp, link and directory-sync step rechecks. Extracted unchanged from
 * `atomic-write.ts` to keep that module within the repository's size rule;
 * package consumers continue to use `atomic-write.ts`.
 */

import { mkdir } from "fs/promises";
import path from "path";
import type { ParentBinding } from "./atomic-write-durability.js";
import { lstat, realpath } from "./fs-metadata.js";
import { confineUnderRoot, isInsideDir, safeRealpath } from "./path-confine.js";

/** The confinement options every parent-preparing writer shares. */
export interface ParentPrepareOptions {
  confineRoot?: string;
  exactParent?: boolean;
  afterParentCheckForTest?: () => Promise<void>;
}

/** Create and bind the exact parent of `filePath`, shared by every atomic writer. */
export async function prepareParent(
  filePath: string,
  opts: ParentPrepareOptions | undefined,
): Promise<{ dir: string; binding: ParentBinding | undefined }> {
  const dir = path.dirname(filePath);
  const realRoot = opts?.confineRoot === undefined
    ? undefined : await assertAncestorInRoot(filePath, opts.confineRoot, opts.exactParent === true);
  await mkdir(dir, { recursive: true });
  const binding = await assertParentNotSymlink(dir, opts?.confineRoot, opts?.exactParent === true, realRoot);
  await opts?.afterParentCheckForTest?.();
  return { dir, binding };
}

/** Fail closed before mkdir when the nearest existing ancestor escapes root; the canonical root when it was resolved. */
export async function assertAncestorInRoot(filePath: string, confineRoot: string, exactParent: boolean): Promise<string | undefined> {
  const relPath = path.relative(confineRoot, filePath);
  const realRoot = exactParent ? await realpath(confineRoot).catch(() => undefined) : undefined;
  if (realRoot === undefined) {
    await confineUnderRoot(relPath, confineRoot, { mustExist: false });
    if (exactParent) await assertCanonicalAncestor(path.dirname(filePath), confineRoot, relPath, await realpath(confineRoot));
    return undefined;
  }
  await assertLeafInRoot(relPath, realRoot);
  await assertCanonicalAncestor(path.dirname(filePath), confineRoot, relPath, realRoot);
  return realRoot;
}

async function assertLeafInRoot(relPath: string, realRoot: string): Promise<void> {
  const leaf = path.normalize(path.resolve(realRoot, relPath));
  if (!isInsideDir(leaf, realRoot)) throw new Error(`path escapes project root: ${relPath}`);
  const realLeaf = await safeRealpath(leaf);
  if (realLeaf !== null && !isInsideDir(realLeaf, realRoot)) throw new Error(`path escapes project root: ${relPath}`);
}

/** Reject even in-root symlink redirects before recursive mkdir can follow them. */
async function assertCanonicalAncestor(dir: string, confineRoot: string, relPath: string, realRoot: string): Promise<void> {
  const lexicalRoot = path.resolve(confineRoot);
  let current = path.resolve(dir);
  for (;;) {
    try {
      const actual = await realpath(current);
      if (!isInsideDir(actual, realRoot)) throw new Error(`path escapes project root: ${relPath}`);
      const expected = path.join(realRoot, path.relative(lexicalRoot, current));
      if (actual !== expected) throw new Error(`write directory redirects from its canonical project path: ${current}`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error("write directory has no canonical project ancestor");
    current = parent;
  }
}

/** Reject a symlinked parent and capture its identity for later binding checks. */
export async function assertParentNotSymlink(
  dir: string, confineRoot?: string, exactParent = false, knownRealRoot?: string,
): Promise<ParentBinding | undefined> {
  const dirStat = await lstat(dir);
  if (dirStat.isSymbolicLink()) {
    throw new Error(`refusing to write through a symlinked directory: ${dir}`);
  }
  if (confineRoot === undefined) return undefined;
  const realRoot = knownRealRoot ?? await realpath(confineRoot);
  const realDir = await realpath(dir);
  if (!isInsideDir(realDir, realRoot)) {
    throw new Error(`write directory escapes project root: ${dir}`);
  }
  const expected = path.join(realRoot, path.relative(path.resolve(confineRoot), path.resolve(dir)));
  if (exactParent && realDir !== expected) throw new Error(`write directory redirects from its canonical project path: ${dir}`);
  return { dir, lexicalRoot: path.resolve(confineRoot), realRoot, realDir, dev: dirStat.dev, ino: dirStat.ino };
}
