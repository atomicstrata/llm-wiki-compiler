/**
 * Safe source-file resolver for the eval harness.
 *
 * Citation markers in wiki pages contain free-form file paths. Before the
 * eval harness reads any file or checks its existence, the path must be
 * confined to the project's `sources/` directory. Three independent layers
 * of defense are applied in order:
 *
 *   1. Structural: reject empty strings, absolute paths, and any `..` segment.
 *   2. Pre-realpath: resolve the joined path and verify it stays under sourcesDir.
 *   3. Symlink: call `fs.realpath` on both sides and verify again, catching
 *      symlinks inside sources/ that point outside the tree.
 *
 * The confinement pattern mirrors `resolveSafePath` in src/context/provenance.ts.
 */

import { realpath } from "fs/promises";
import path from "path";

/**
 * True when any `/`- or `\`-separated segment of `file` is literally `..`.
 * Splitting on both separators ensures a `nested\..\escape.md` path written
 * for a Windows consumer is also caught on Linux where `\` is a valid filename
 * character.
 */
function containsParentSegment(file: string): boolean {
  return file.split(/[/\\]/).some((seg) => seg === "..");
}

/** True when `candidate` equals `parent` or sits beneath it. */
function isInside(parent: string, candidate: string): boolean {
  if (candidate === parent) return true;
  const parentWithSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return candidate.startsWith(parentWithSep);
}

/**
 * Resolve `file` under `sourcesDir`, rejecting:
 *   - empty strings and absolute paths (`/etc/passwd`)
 *   - any path segment that is literally `..` (traversal, even normalizing back
 *     inside sources/ is rejected — the raw marker must be unambiguous)
 *   - paths that resolve outside `sourcesDir` after normalization
 *   - paths whose `realpath` escapes `sourcesDir` (symlink escapes)
 *
 * Returns the canonical absolute path on success, or `null` if the path is
 * rejected, the sources directory does not exist, or the file is not found.
 *
 * @param sourcesDir - Absolute path to the project's sources/ directory.
 * @param file - Relative file path from a citation marker (untrusted input).
 */
export async function resolveSourceFile(
  sourcesDir: string,
  file: string,
): Promise<string | null> {
  if (file.length === 0 || path.isAbsolute(file)) return null;
  if (containsParentSegment(file)) return null;
  const joined = path.join(sourcesDir, file);
  if (!isInside(sourcesDir, path.resolve(joined))) return null;
  try {
    const realDir = await realpath(sourcesDir);
    const realFile = await realpath(joined);
    if (!isInside(realDir, realFile)) return null;
    return realFile;
  } catch {
    return null;
  }
}
