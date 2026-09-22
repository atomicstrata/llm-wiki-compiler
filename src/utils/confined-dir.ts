/**
 * @file src/utils/confined-dir.ts
 * @description The CAP-AWARE confined directory lister: walks a project-owned
 * directory lazily through `opendir` and STOPS at cap+1, refusing the directory
 * as unavailable — bounded by construction. The older `confinedEntries`
 * (`profile/templates/corpus.ts`) calls `readdir()`, which materializes every
 * name BEFORE its caller can check a limit, so it is not actually bounded and
 * is not reused for sweeps an adversary can inflate (an artifact slug dir).
 *
 * Entries are reported by KIND from `lstat`-equivalent Dirent flags — a
 * symlink is a symlink, never followed — so callers can refuse non-regular
 * entries without a second stat.
 */

import { lstat, opendir } from "node:fs/promises";
import { confineUnderRoot } from "./path-confine.js";

/** One directory entry and its unfollowed kind. */
export interface ConfinedDirEntry {
  readonly name: string;
  readonly kind: "file" | "directory" | "symlink" | "other";
}

/** A bounded listing, or why none could be produced. */
export type ConfinedDirListing =
  | { kind: "ok"; entries: ConfinedDirEntry[] }
  | { kind: "absent" }
  | { kind: "unavailable" };

/** Classify a Dirent without following anything. */
function kindOf(entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): ConfinedDirEntry["kind"] {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  return "other";
}

/**
 * List `relativeDir` (confined under `root`) with at most `maxEntries` entries.
 *
 * @param root - Absolute project root.
 * @param relativeDir - The directory, relative to root (never followed out of it).
 * @param maxEntries - The cap; the (cap+1)-th entry refuses the listing as unavailable.
 * @returns The entries in enumeration order, `absent` when the directory does
 *   not exist, or `unavailable` for anything else (escape, not a directory,
 *   unreadable, over the cap).
 */
export async function listConfinedDirBounded(root: string, relativeDir: string, maxEntries: number): Promise<ConfinedDirListing> {
  let dir: string;
  try {
    dir = await confineUnderRoot(relativeDir, root, { mustExist: false });
    const st = await lstat(dir);
    if (!st.isDirectory()) return { kind: "unavailable" };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unavailable" };
  }
  const entries: ConfinedDirEntry[] = [];
  try {
    // `for await` closes the handle on completion AND on early return.
    for await (const entry of await opendir(dir)) {
      entries.push({ name: entry.name, kind: kindOf(entry) });
      if (entries.length > maxEntries) return { kind: "unavailable" };
    }
  } catch {
    return { kind: "unavailable" };
  }
  return { kind: "ok", entries };
}
