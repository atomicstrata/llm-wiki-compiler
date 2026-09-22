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

import { lstat, realpath, rmdir, unlink } from "node:fs/promises";
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
 * already committed earlier steps.
 */
export async function rmdirConfinedDurable(root: string, dir: string, expectedParent: string): Promise<void> {
  const canonicalParent = await resolveExpectedReal(root, expectedParent);
  const parentReal = await realpath(path.dirname(dir)).catch(() => null);
  if (canonicalParent === null || parentReal === null || parentReal !== canonicalParent) {
    throw new Error("confined rmdir parent is not the expected directory");
  }
  const leaf = await lstatLeaf(dir);
  if (leaf.kind === "absent") return;
  if (leaf.kind !== "present" || !leaf.stats.isDirectory() || leaf.stats.isSymbolicLink()) {
    throw new Error("confined rmdir target is not a real directory");
  }
  await rmdir(dir);
  await fsyncDirectoryChain(parentReal);
}
