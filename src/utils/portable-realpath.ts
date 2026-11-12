/**
 * @file src/utils/portable-realpath.ts
 * @description `realpath` that canonicalizes an unreadable leaf the way POSIX
 * `realpath(3)` does.
 *
 * Bun's `fs.promises.realpath` opens the path to ask the kernel for its name,
 * so it fails with `EACCES` on a directory or file the process cannot read
 * (mode 000, or an execute-only directory). Node's resolves such a path, since
 * resolving a name needs search permission on the ancestors only. Callers that
 * classify "present but unreadable" separately from "redirected" depend on the
 * Node behaviour, so this restores it: a non-symlink leaf's canonical path is
 * its parent's canonical path plus its own name.
 */

import { lstat, realpath } from "./fs-metadata.js";
import path from "node:path";

/** Permission errnos Bun's realpath raises for an unreadable but present leaf. */
const UNREADABLE_LEAF_CODES = new Set(["EACCES", "EPERM"]);

/**
 * Canonical path of `target`, tolerating a leaf the process cannot read.
 *
 * @param target - Path to canonicalize.
 * @returns The canonical path; rejects exactly as `realpath` would otherwise.
 */
export async function portableRealpath(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (!UNREADABLE_LEAF_CODES.has(code)) throw error;
    // A symlinked leaf must be followed, which needs the real call; keep its error.
    if ((await lstat(target)).isSymbolicLink()) throw error;
    // The parent may be unreadable too (an execute-only directory), so recurse.
    return path.join(await portableRealpath(path.dirname(target)), path.basename(target));
  }
}
