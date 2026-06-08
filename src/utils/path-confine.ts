/**
 * Path-confinement helpers shared by source/wiki readers. Used to drop any
 * entry whose `realpath` escapes its intended directory (e.g. a symlinked
 * `sources/leak.md` pointing outside the project), preventing local-file-read.
 *
 * Also exports `resolveSourcesDir` which additionally guards against the
 * `sources/` directory itself being a symlink to an outside location.
 */
import { realpath, lstat } from "fs/promises";
import path from "path";
import { SOURCES_DIR } from "./constants.js";

/** `realpath` that returns null instead of throwing on missing/broken paths. */
export async function safeRealpath(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/** True when `child` equals `dir` or sits beneath it. */
export function isInsideDir(child: string, dir: string): boolean {
  if (child === dir) return true;
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return child.startsWith(prefix);
}

/**
 * Resolve the trusted on-disk sources directory for `root`: `<realpath(root)>/sources`,
 * requiring `sources/` to be a REAL directory at that literal path. A symlinked
 * `sources/` (which would redirect every read/write outside the project) yields null.
 * Returns null when root is missing or `sources/` is absent / not a real directory.
 */
export async function resolveSourcesDir(root: string): Promise<string | null> {
  const canonicalRoot = await safeRealpath(root);
  if (canonicalRoot === null) return null;
  const sourcesDir = path.join(canonicalRoot, SOURCES_DIR);
  try {
    const st = await lstat(sourcesDir);
    if (!st.isDirectory()) return null; // symlink or non-dir → not trusted
  } catch {
    return null; // missing
  }
  return sourcesDir;
}
