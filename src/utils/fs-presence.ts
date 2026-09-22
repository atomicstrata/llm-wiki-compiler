/**
 * @file src/utils/fs-presence.ts
 * @description The one place that answers "is this path there?" without losing the
 * difference between NOT THERE and COULD NOT TELL. `lstat(...).catch(() => null)` is
 * the recurring shape behind an entire defect class: a permission flip or I/O fault
 * becomes indistinguishable from absence, and every caller that treats absence as
 * permissive — nothing pending, nothing to move, safe to proceed — silently relaxes a
 * safety state on an error an attacker can induce. Callers must handle `unavailable`
 * explicitly, which is exactly the decision that must not be made by omission.
 */

import { lstat, readdir } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";

/**
 * lstat one leaf without following it, separating ENOENT from any other fault. The
 * result keeps "could not tell" distinct from "not there".
 */
export async function lstatLeaf(
  file: string,
): Promise<{ kind: "present"; stats: Stats } | { kind: "absent" } | { kind: "unavailable" }> {
  try {
    return { kind: "present", stats: await lstat(file) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unavailable" };
  }
}

/**
 * Read one directory's entry names, separating ENOENT from any other fault. The result
 * keeps "could not read" distinct from "not there".
 */
export async function readDirectoryNames(
  directory: string,
): Promise<{ kind: "entries"; names: readonly string[] } | { kind: "absent" } | { kind: "unavailable" }> {
  try {
    return { kind: "entries", names: await readdir(directory) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unavailable" };
  }
}

/**
 * List a registry directory whose entries must all be plain unit directories. The ROOT
 * is validated without following it, and any symlink or non-directory entry makes the
 * whole listing `unavailable` rather than being skipped — a real unit moved aside and
 * replaced by a link must never read as "gone".
 */
export async function listUnitDirectories(
  registry: string,
): Promise<{ status: "ok"; unitIds: readonly string[] } | { status: "unavailable" }> {
  const rootLeaf = await lstatLeaf(registry);
  if (rootLeaf.kind === "absent") return { status: "ok", unitIds: [] };
  if (rootLeaf.kind === "unavailable" || !rootLeaf.stats.isDirectory() || rootLeaf.stats.isSymbolicLink()) {
    return { status: "unavailable" };
  }
  let entries: Dirent[];
  try {
    entries = await readdir(registry, { withFileTypes: true });
  } catch {
    return { status: "unavailable" };
  }
  if (entries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())) return { status: "unavailable" };
  return { status: "ok", unitIds: entries.map((entry) => entry.name).sort() };
}
