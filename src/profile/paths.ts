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
 * VCS/dependency dirs). Overlap is tested with `isInsideDir` in both
 * directions so neither a parent nor a child of a reserved root slips through.
 */

import path from "path";
import { isInsideDir } from "../utils/path-confine.js";

/** The directory every entity type's pages must live under. */
const WIKI_ROOT = "wiki";

/** Error raised when a profile declares a structurally invalid directory. */
export class ProfilePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfilePathError";
  }
}

/** True when a path segment is empty, `..`, or contains a NUL byte. */
function isUnsafeSegment(segment: string): boolean {
  return segment === "" || segment === ".." || segment.includes("\0");
}

/**
 * Normalize a declared directory to a clean POSIX-relative form for comparison,
 * or throw if it is absolute, contains a NUL byte, or has an unsafe segment.
 */
function normalizeDeclaredDir(dir: string): string {
  if (dir.includes("\0")) throw new ProfilePathError(`directory contains a NUL byte: ${JSON.stringify(dir)}`);
  if (path.isAbsolute(dir)) throw new ProfilePathError(`directory must be repo-relative, not absolute: ${dir}`);
  const segments = dir.split(/[\\/]/);
  for (const segment of segments) {
    if (isUnsafeSegment(segment)) {
      throw new ProfilePathError(`directory has an empty, '..', or NUL segment: ${dir}`);
    }
  }
  return segments.join(path.posix.sep);
}

/** True when `a` and `b` overlap: either is at or beneath the other. */
function pathsOverlap(a: string, b: string): boolean {
  return isInsideDir(a, b) || isInsideDir(b, a);
}

/**
 * Validate the DECLARED directory for an entity type. Throws ProfilePathError
 * on any violation; returns void when the path is structurally sound.
 *
 * @param dir - the repo-relative directory declared for the entity type.
 * @param reservedRoots - repo-relative roots an entity dir may not overlap
 *   (e.g. `sources`, `.llmwiki`, `.git`, `node_modules`, build output, the OKF
 *   export dir, `wiki/graph`).
 */
export function validateEntityDirectory(dir: string, reservedRoots: string[]): void {
  const clean = normalizeDeclaredDir(dir);
  if (!isInsideDir(clean, WIKI_ROOT)) {
    throw new ProfilePathError(`entity directory must be under '${WIKI_ROOT}/': ${dir}`);
  }
  for (const reserved of reservedRoots) {
    const cleanReserved = normalizeDeclaredDir(reserved);
    if (pathsOverlap(clean, cleanReserved)) {
      throw new ProfilePathError(`entity directory overlaps reserved root '${reserved}': ${dir}`);
    }
  }
}
