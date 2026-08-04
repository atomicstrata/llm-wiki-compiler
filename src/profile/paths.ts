/**
 * Structural validator for an entity type's DECLARED directory.
 *
 * This is the v0 profile path check: it validates the SHAPE of the
 * repo-relative directory a profile declares for an entity type, before any
 * file is read or written. It is deliberately purely lexical — write-boundary
 * O_NOFOLLOW confinement against symlink races is a later phase. Here we only
 * guarantee the declared path is: repo-relative, segment-clean (no `..`, NUL,
 * or empty segment), rooted under `wiki/`, and non-overlapping with any
 * reserved root (sources, build output, the OKF export dir, the graph dir,
 * VCS/dependency dirs). Overlap is tested with `isInsidePosixDir` in both
 * directions so neither a parent nor a child of a reserved root slips through.
 * Every comparison here is POSIX-separated: these are declared, repo-relative
 * paths, never native filesystem paths.
 */

import path from "path";

/** The directory every entity type's pages must live under. */
const WIKI_ROOT = "wiki";

/** Error raised when a profile declares a structurally invalid directory. */
export class ProfilePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfilePathError";
  }
}

/** True when a path segment is `..` or contains a NUL byte (never traversable). */
function isUnsafeSegment(segment: string): boolean {
  return segment === ".." || segment.includes("\0");
}

/**
 * Normalize a declared directory to a clean, canonical POSIX-relative form, or
 * throw if it is absolute, contains a NUL byte, or has a `..` segment.
 *
 * `.` and empty (trailing-slash / doubled-slash) segments carry no meaning and
 * are DROPPED so equivalent spellings collapse to one canonical directory —
 * e.g. `wiki/papers` and `wiki/papers/.` both yield `wiki/papers`. This makes
 * the canonical form the single value used for both uniqueness and scanning, so
 * two entities can't bypass directory uniqueness with a `.`-padded alias.
 *
 * SEPARATOR RULE — this function is the ONE place that decides it. Splitting on
 * `[\\/]` makes a backslash a SEPARATOR, so a profile authored on Windows
 * (`wiki\papers`) canonicalizes to `wiki/papers` and loads everywhere. Two
 * consequences follow, and both are intended:
 *  - a directory whose NAME literally contains a backslash (legal on POSIX) is
 *    not addressable from a profile — it is read as two segments;
 *  - `..` is checked AFTER the split, so `wiki\..\..\etc` is rejected rather
 *    than smuggled past a `/`-only split. Treating `\` as a separator is what
 *    keeps that fail-closed.
 * Everything downstream therefore receives `/`-joined text and may compare it
 * lexically — see {@link isInsidePosixDir}.
 */
function normalizeDeclaredDir(dir: string): string {
  if (dir.includes("\0")) throw new ProfilePathError(`directory contains a NUL byte: ${JSON.stringify(dir)}`);
  if (path.isAbsolute(dir)) throw new ProfilePathError(`directory must be repo-relative, not absolute: ${dir}`);
  const segments = dir.split(/[\\/]/);
  for (const segment of segments) {
    if (isUnsafeSegment(segment)) {
      throw new ProfilePathError(`directory has a '..' or NUL segment: ${dir}`);
    }
  }
  return segments.filter((s) => s !== "" && s !== ".").join(path.posix.sep);
}

/**
 * True when `child` equals `dir` or sits beneath it, comparing CANONICAL
 * REPO-RELATIVE POSIX paths — the `/`-joined form {@link normalizeDeclaredDir}
 * produces.
 *
 * Deliberately NOT `isInsideDir` from `utils/path-confine.js`. That helper
 * builds its prefix with the PLATFORM separator, which is right for the native
 * absolute realpaths symlink confinement compares, and wrong here: declared
 * directories are always `/`-joined, so on win32 `path.sep` ("\") made every
 * nested directory fail containment and no profile could load (issue #163).
 *
 * Inputs are NOT normalized here, and must not be: separator resolution belongs
 * to {@link normalizeDeclaredDir}, which has already run on everything this
 * receives. Adding a `\`→`/` rewrite would make the helper accept a RAW declared
 * path, silently duplicating that decision in a second place — the way these two
 * drift apart. A backslash reaching this function means a caller skipped
 * canonicalization; failing to match is the correct, fail-closed answer.
 */
export function isInsidePosixDir(child: string, dir: string): boolean {
  if (child === dir) return true;
  return child.startsWith(dir.endsWith(path.posix.sep) ? dir : dir + path.posix.sep);
}

/** True when `a` and `b` overlap: either is at or beneath the other. */
function pathsOverlap(a: string, b: string): boolean {
  return isInsidePosixDir(a, b) || isInsidePosixDir(b, a);
}

/**
 * Validate the DECLARED directory for an entity type. Throws ProfilePathError
 * on any violation; returns the CANONICAL normalized directory when the path is
 * structurally sound. Callers must use the returned canonical value for both
 * uniqueness and scanning so equivalent spellings can't diverge.
 *
 * @param dir - the repo-relative directory declared for the entity type.
 * @param reservedRoots - repo-relative roots an entity dir may not overlap
 *   (e.g. `sources`, `.llmwiki`, `.git`, `node_modules`, build output, the OKF
 *   export dir, `wiki/graph`).
 * @returns The canonical, normalized repo-relative directory.
 */
export function validateEntityDirectory(dir: string, reservedRoots: string[]): string {
  const clean = normalizeDeclaredDir(dir);
  if (!isInsidePosixDir(clean, WIKI_ROOT)) {
    throw new ProfilePathError(`entity directory must be under '${WIKI_ROOT}/': ${dir}`);
  }
  for (const reserved of reservedRoots) {
    const cleanReserved = normalizeDeclaredDir(reserved);
    if (pathsOverlap(clean, cleanReserved)) {
      throw new ProfilePathError(`entity directory overlaps reserved root '${reserved}': ${dir}`);
    }
  }
  return clean;
}
