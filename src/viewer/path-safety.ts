/**
 * Path-safety primitives for the local web viewer.
 *
 * Three layered checks form the v1 path-confinement chain. The HTTP layer
 * (Slice 2) is responsible for calling them in order at route entry:
 *
 *   1. Decode the URL path segment exactly once with `decodeURIComponent`.
 *   2. `assertSafeSlug(decoded)` — reject separators, NUL, traversal-as-slug.
 *   3. `resolveUnderRoot(root, ...segments)` — `realpath` both sides, confirm
 *      the joined target stays inside `realpath(root)`. Catches symlink
 *      escapes that survive a clean slug.
 *   4. `assertViewerSubtree(root, resolved)` — named-allowlist confinement
 *      to `wiki/`, `sources/`, and `.llmwiki/last-lint.json` only. Anything
 *      else under root (including other `.llmwiki/*`, `.git/`, `node_modules/`)
 *      is rejected even though `realpath` resolved it cleanly.
 */

import { realpath } from "fs/promises";
import path from "path";
import {
  CONCEPTS_DIR,
  QUERIES_DIR,
  SOURCES_DIR,
  LAST_LINT_FILE,
} from "../utils/constants.js";

/** Error thrown when any path-safety check rejects an input. */
export class PathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathSafetyError";
  }
}

/**
 * Reject decoded slug values that would let a request escape its intended
 * file. Run AFTER `decodeURIComponent` — percent-encoded traversal becomes
 * literal `..` here and is caught. Unicode slugs (any letter or number
 * code point) are accepted; only structural metacharacters are rejected.
 */
export function assertSafeSlug(decodedSlug: string): void {
  if (typeof decodedSlug !== "string") {
    throw new PathSafetyError("slug must be a string");
  }
  if (decodedSlug.length === 0) {
    throw new PathSafetyError("slug must not be empty");
  }
  if (decodedSlug === "." || decodedSlug === "..") {
    throw new PathSafetyError(`slug must not be "${decodedSlug}"`);
  }
  if (decodedSlug.includes("/") || decodedSlug.includes("\\")) {
    throw new PathSafetyError("slug must not contain path separators");
  }
  if (decodedSlug.includes("\0")) {
    throw new PathSafetyError("slug must not contain NUL bytes");
  }
  if (path.sep !== "/" && decodedSlug.includes(path.sep)) {
    throw new PathSafetyError(`slug must not contain platform separator "${path.sep}"`);
  }
}

/**
 * Join `root` and `safeSegments`, resolve symlinks on both ends, and
 * confirm the target stays inside `realpath(root)`. Absolute segments are
 * rejected up-front so a single bad input cannot pivot the join away from
 * `root`. Callers MUST run `assertSafeSlug` on every untrusted segment
 * before this — `resolveUnderRoot` does not re-validate slug shape.
 */
export async function resolveUnderRoot(
  root: string,
  ...safeSegments: string[]
): Promise<string> {
  for (const segment of safeSegments) {
    if (typeof segment !== "string" || segment.length === 0) {
      throw new PathSafetyError("path segment must be a non-empty string");
    }
    if (path.isAbsolute(segment)) {
      throw new PathSafetyError("path segment must not be absolute");
    }
  }
  const joined = path.join(root, ...safeSegments);
  const realRoot = await realpath(root);
  const realTarget = await realpath(joined);
  const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (realTarget !== realRoot && !realTarget.startsWith(rootWithSep)) {
    throw new PathSafetyError("resolved path escapes project root");
  }
  return realTarget;
}

/**
 * Confine an already-resolved path to the viewer's read allowlist. The
 * spec says "read-only metadata under `.llmwiki/`" — encoded here as a
 * named allowlist (the single file `.llmwiki/last-lint.json`) rather than
 * the full subtree, so a future viewer addition cannot accidentally
 * expose arbitrary `.llmwiki/*` contents over HTTP.
 *
 * The function is async because both `root` and the allowlist entries
 * are canonicalized via `fs.realpath` before comparison — without that,
 * a project root that itself is a symlink (a common workflow: cloning
 * into `~/code/project` which is a symlink to `/Volumes/Work/project`)
 * would false-reject every legitimate file. Callers may pass the raw
 * project root from `process.cwd()` and trust this helper to do the
 * canonicalization. Allowlist entries that do not exist on disk fall
 * back to a non-canonicalized join, so an empty project (no `sources/`
 * yet) still has a sensible allowlist.
 */
export async function assertViewerSubtree(root: string, resolvedPath: string): Promise<void> {
  const canonicalRoot = await canonicalizeOrFallback(root);
  const allowlistDirs = await Promise.all([
    canonicalizeOrFallback(path.join(canonicalRoot, "wiki")),
    canonicalizeOrFallback(path.join(canonicalRoot, CONCEPTS_DIR)),
    canonicalizeOrFallback(path.join(canonicalRoot, QUERIES_DIR)),
    canonicalizeOrFallback(path.join(canonicalRoot, SOURCES_DIR)),
  ]);
  const lintCachePath = await canonicalizeOrFallback(path.join(canonicalRoot, LAST_LINT_FILE));

  for (const dir of allowlistDirs) {
    if (isInsideOrEqual(resolvedPath, dir)) return;
  }
  if (resolvedPath === lintCachePath) return;

  throw new PathSafetyError("path is outside the viewer-approved subtrees");
}

/**
 * Canonicalize `candidate` via `realpath`. Falls back to a normalized
 * stripped-trailing-separator string when the entry does not exist —
 * the allowlist tolerates absent directories (an empty project may have
 * no `sources/` yet) without rejecting every later check.
 */
async function canonicalizeOrFallback(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return candidate.endsWith(path.sep) ? candidate.slice(0, -1) : candidate;
  }
}

/** True when `candidate` equals `parent` or sits beneath it. */
function isInsideOrEqual(candidate: string, parent: string): boolean {
  if (candidate === parent) return true;
  const parentWithSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return candidate.startsWith(parentWithSep);
}
