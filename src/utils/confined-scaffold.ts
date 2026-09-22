/**
 * @file src/utils/confined-scaffold.ts
 * @description Create project directories that stay CONFINED under the project
 * root, for cold-init scaffolding. Each directory is resolved through the same
 * hardened `confineUnderRoot` primitive used everywhere else: a path whose
 * nearest existing ancestor is a symlink escaping the root is refused before any
 * directory is created, and each created target is re-verified to be a real
 * (non-symlink) directory whose realpath is still inside the real root. So a
 * pre-existing `<root>/wiki` (or leaf) symlink to an outside location cannot
 * redirect the scaffolded tree out of the project.
 *
 * The operation is a pure directory creator: it creates missing directories and
 * leaves existing ones untouched (scaffolding never clobbers a populated
 * project).
 */

import { lstat, mkdir, realpath } from "node:fs/promises";
import { confineUnderRoot, isInsideDir } from "./path-confine.js";

/** The outcome of a scaffold pass: which project-relative dirs were new vs already present. */
export interface ScaffoldDirectoriesResultV1 {
  /** Directories created by this pass (relative, in the order requested, de-duplicated). */
  readonly created: readonly string[];
  /** Directories that already existed (the idempotence witness). */
  readonly existing: readonly string[];
}

/**
 * Confine one relative directory under `root`, create it, and verify it is a
 * real directory still inside the real root. Returns whether it was newly
 * created. Throws if the path escapes the root (e.g. through a symlink).
 * @param root - Absolute project root.
 * @param relDir - A project-relative directory path.
 */
export async function ensureConfinedDirectory(root: string, relDir: string): Promise<boolean> {
  const target = await confineUnderRoot(relDir, root, { mustExist: false });
  const firstCreated = await mkdir(target, { recursive: true });
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`scaffold target is not a real directory: ${relDir}`);
  }
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  if (!isInsideDir(realTarget, realRoot)) {
    throw new Error(`scaffold target escapes the project root: ${relDir}`);
  }
  return firstCreated !== undefined;
}

/**
 * Idempotently create each of `relDirs` confined under `root` (de-duplicated,
 * preserving first-seen order), reporting which were created vs already present.
 * @param root - Absolute project root.
 * @param relDirs - Project-relative directories to scaffold.
 */
export async function scaffoldConfinedDirectories(
  root: string, relDirs: Iterable<string>,
): Promise<ScaffoldDirectoriesResultV1> {
  const created: string[] = [];
  const existing: string[] = [];
  for (const relDir of new Set(relDirs)) {
    (await ensureConfinedDirectory(root, relDir) ? created : existing).push(relDir);
  }
  return { created, existing };
}
