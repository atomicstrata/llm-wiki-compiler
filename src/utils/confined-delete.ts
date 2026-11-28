/**
 * @file src/utils/confined-delete.ts
 * @description The delete-time counterpart to the confined reader. Removing a
 * sensitive leaf needs the same confinement the reader applies: a `lstat` guards
 * only the FINAL component, so a PARENT directory swapped for a symlink can still
 * redirect an `unlink` outside the project. Every delete here re-resolves the
 * parent's realpath against `realpath(root)` before unlinking, refuses anything that
 * is not a regular file, and fsyncs the parent so the removal survives power loss
 * rather than reappearing after the caller reported success.
 */

import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fsyncDirectoryChain } from "./atomic-write-durability.js";
import { resolveExpectedReal } from "./confined-read.js";
import { lstatLeaf } from "./fs-presence.js";

/**
 * Durably unlink one exact regular-file leaf that must live directly inside
 * `expectedDir` under `root`. An already-absent leaf is a no-op so a crashed cleanup
 * pass resumes idempotently; a swapped parent, a symlinked leaf, or a non-regular
 * file is refused rather than followed.
 */
export async function unlinkConfinedLeafDurable(root: string, leaf: string, expectedDir: string): Promise<void> {
  const canonicalDir = await resolveExpectedReal(root, expectedDir);
  if (canonicalDir === null) throw new Error("confined delete root is unavailable");
  const parentReal = await realpath(path.dirname(leaf)).catch(() => null);
  if (parentReal === null || parentReal !== canonicalDir) {
    throw new Error("confined delete parent is not the expected directory");
  }
  const present = await lstat(leaf).catch(() => null);
  if (present === null) return;
  if (!present.isFile() || present.isSymbolicLink()) throw new Error("confined delete target is not a regular file");
  await unlink(leaf);
  await fsyncDirectoryChain(parentReal);
}

/**
 * Classify one directory before anything is written through or destroyed inside it.
 * Unit paths are only ever built lexically, so a unit replaced by a symlink would
 * otherwise be read through and then mutated, destroying bytes outside the project.
 *
 * `absent` is reported only for a PROVED absence: a directory that merely cannot be
 * examined is `redirected`, because treating an unreadable path as "not there yet"
 * would let a permission fault turn into permission to create and write through it.
 */
export async function isConfinedDirectory(root: string, dir: string): Promise<"confined" | "absent" | "redirected"> {
  const leaf = await lstatLeaf(dir);
  if (leaf.kind === "absent") return "absent";
  if (leaf.kind !== "present" || !leaf.stats.isDirectory() || leaf.stats.isSymbolicLink()) return "redirected";
  const canonical = await resolveExpectedReal(root, dir);
  const actual = await realpath(dir).catch(() => null);
  return canonical !== null && actual !== null && actual === canonical ? "confined" : "redirected";
}

/**
 * Remove one EMPTY directory that must sit directly inside `expectedParent` under
 * `root`, then persist the removal. The directory is re-confined and proved a real
 * non-symlink directory immediately before the call, because a symlinked directory
 * reads as empty through `readdir` and `rmdir` would then fail — after the caller had
 * already committed earlier steps. With `expected`, the directory must also still be
 * that exact (full-width) identity right before the `rmdir`, and its ABSENCE is a
 * change (refused), not a removal already done; without it, absence stays a no-op.
 */
export async function rmdirConfinedDurable(root: string, dir: string, expectedParent: string, expected?: DirIdentity): Promise<void> {
  const canonicalParent = await resolveExpectedReal(root, expectedParent);
  const parentReal = await realpath(path.dirname(dir)).catch(() => null);
  if (canonicalParent === null || parentReal === null || parentReal !== canonicalParent) {
    throw new Error("confined rmdir parent is not the expected directory");
  }
  const leaf = await lstatLeaf(dir);
  if (leaf.kind === "absent" && expected !== undefined) throw new Error("confined rmdir target is gone, not the expected directory");
  if (leaf.kind === "absent") return;
  if (leaf.kind !== "present" || !leaf.stats.isDirectory() || leaf.stats.isSymbolicLink()) {
    throw new Error("confined rmdir target is not a real directory");
  }
  if (expected !== undefined && !(await isDirIdentity(dir, expected))) throw new Error("confined rmdir target is not the expected directory");
  await rmdir(dir);
  await fsyncDirectoryChain(parentReal);
}

/** A directory's exact full-width identity. */
export interface DirIdentity { readonly dev: bigint; readonly ino: bigint }

/** Whether `dir` is now a real directory with exactly identity `expected` (never a lossy comparison). */
async function isDirIdentity(dir: string, expected: DirIdentity): Promise<boolean> {
  const now = await lstat(dir, { bigint: true }).catch(() => null);
  return now !== null && now.isDirectory() && now.dev === expected.dev && now.ino === expected.ino;
}

/** What one identity-bound confined unlink did. */
export type BoundUnlinkOutcome = "unlinked" | "changed";

/**
 * Unlink one leaf directly inside `expectedDir` under `root` ONLY when it is
 * still the exact file the caller inventoried: the parent re-resolves to the
 * canonical in-root directory at this last seam, and the leaf is a regular,
 * single-link, non-symlink file for which `matches` (its bigint stat) holds.
 * Anything else is `changed` and nothing is unlinked. The caller syncs the
 * directory once after a batch (`fsyncConfinedDirectory`). With
 * `expectedParent`, the parent must also still be that exact (full-width)
 * directory identity at this last seam.
 */
export async function unlinkConfinedLeafIfIdentity(
  root: string, leaf: string, expectedDir: string, matches: (stat: import("node:fs").BigIntStats) => boolean, expectedParent?: DirIdentity,
): Promise<BoundUnlinkOutcome> {
  const canonicalDir = await resolveExpectedReal(root, expectedDir);
  const parentReal = await realpath(path.dirname(leaf)).catch(() => null);
  if (canonicalDir === null || parentReal !== canonicalDir) return "changed";
  if (expectedParent !== undefined && !(await isDirIdentity(path.dirname(leaf), expectedParent))) return "changed";
  const present = await lstat(leaf, { bigint: true }).catch(() => null);
  if (present === null || !present.isFile() || present.isSymbolicLink() || present.nlink !== 1n || !matches(present)) return "changed";
  await unlink(leaf);
  return "unlinked";
}

/**
 * Durably sync `dir` after confined unlinks, refusing a redirected directory.
 * With `expected`, the directory handle that is actually synced must be that
 * exact (full-width) identity, so a replacement at the path is never synced in
 * its place; without it, the incumbent single-directory chain sync is used.
 */
export async function fsyncConfinedDirectory(root: string, dir: string, expected?: DirIdentity): Promise<void> {
  const canonicalDir = await resolveExpectedReal(root, dir);
  const real = await realpath(dir).catch(() => null);
  if (canonicalDir === null || real !== canonicalDir) throw new Error("confined directory sync target is not the expected directory");
  if (expected === undefined) return fsyncDirectoryChain(real);
  const handle = await open(real, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    const held = await handle.stat({ bigint: true });
    if (!held.isDirectory() || held.dev !== expected.dev || held.ino !== expected.ino) throw new Error("confined directory sync target is not the expected directory");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
