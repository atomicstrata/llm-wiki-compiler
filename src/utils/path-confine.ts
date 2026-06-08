/**
 * Path-confinement helpers shared by source/wiki readers. Used to drop any
 * entry whose `realpath` escapes its intended directory (e.g. a symlinked
 * `sources/leak.md` pointing outside the project), preventing local-file-read.
 */
import { realpath } from "fs/promises";
import path from "path";

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
