/**
 * Computed source-freshness layer.
 *
 * Derives a page's freshness on demand from a FreshnessSnapshot (state.json
 * hashes + current source hashes). Pure — never reads or writes the filesystem
 * and never persists freshness. See localdocs/specs/2026-06-04-source-freshness-design.md.
 */

import type { FreshnessSnapshot, PageFreshness, PageFreshnessInput, FreshnessStatus, SourceFreshness } from "./types.js";
import { existsSync } from "fs";
import { realpath } from "fs/promises";
import path from "path";
import { readStateClassified } from "../utils/state.js";
import type { ClassifiedState } from "../utils/state.js";
import { hashFile } from "../compiler/hasher.js";
import { SOURCES_DIR } from "../utils/constants.js";

/** Compute the three orthogonal freshness signals for one page. */
export function computeFreshness(page: PageFreshnessInput, snapshot: FreshnessSnapshot): PageFreshness {
  return {
    freshnessStatus: classify(page, snapshot),
    contradicted: Array.isArray(page.frontmatter.contradictedBy) && page.frontmatter.contradictedBy.length > 0,
    archived: page.frontmatter.archived === true,
  };
}

/** Source-derived freshness status, per the spec's ordered ownership algorithm. */
function classify(page: PageFreshnessInput, snapshot: FreshnessSnapshot): FreshnessStatus {
  if (snapshot.stateStatus !== "ok") return "unverified";
  // Query pages are generated answers, not source projections — always unverified,
  // never orphaned/fresh (they also never receive `orphaned` frontmatter).
  if (page.pageDirectory === "queries") return "unverified";
  if (page.frontmatter.orphaned === true) return "orphaned";

  const owners = ownersOf(page.slug, snapshot);
  if (owners.length === 0) return "unverified";

  const live = owners.filter((o) => o.exists);
  if (live.length === 0) return "orphaned";
  if (live.length < owners.length) return "stale";
  if (live.some((o) => o.currentHash !== o.recordedHash)) return "stale";
  return "fresh";
}

/** Sources whose recorded concept set includes this page's slug (state is authoritative). */
function ownersOf(slug: string, snapshot: FreshnessSnapshot) {
  return Object.values(snapshot.sources).filter((s) => s.concepts.includes(slug));
}

/**
 * Build the per-run freshness snapshot: one read-only state read + one hash
 * pass over sources/. Shared by every freshness consumer so hashing happens once.
 *
 * @param classified - Optional pre-read classified state. When supplied the
 *   disk read is skipped, letting callers that already have state avoid a
 *   redundant read. Omit (or pass `undefined`) to read from disk as usual.
 */
export async function buildFreshnessSnapshot(
  root: string,
  classified?: ClassifiedState,
): Promise<FreshnessSnapshot> {
  const { status, state } = classified ?? (await readStateClassified(root));
  const sources: FreshnessSnapshot["sources"] = {};
  if (status === "ok") {
    const sourcesRoot = path.resolve(root, SOURCES_DIR);
    // Resolve the real sources root ONCE — the per-source containment check reuses it,
    // so a snapshot over N sources does at most N (not 2N) realpath syscalls.
    const realSourcesRoot = await realSourcesRootOrFallback(sourcesRoot);
    for (const [file, entry] of Object.entries(state.sources)) {
      sources[file] = await classifySource(sourcesRoot, realSourcesRoot, file, entry);
    }
  }
  return { stateStatus: status, sources };
}

/**
 * Real path of the sources root, falling back to the lexical path if realpath
 * throws (e.g. sources/ does not exist yet). The fallback is safe: a missing
 * sources root means no source file can resolve inside it, and per-file
 * existsSync already gates hashing.
 */
async function realSourcesRootOrFallback(sourcesRoot: string): Promise<string> {
  try {
    return await realpath(sourcesRoot);
  } catch {
    return sourcesRoot;
  }
}

/**
 * Resolve a file's symlinks and check whether its real path is inside the
 * pre-resolved real sources root. The root is realpath'd once by the caller so
 * projects under symlinked temp dirs (e.g. macOS /tmp → /private/tmp) still pass.
 * Returns false on any error (treat as not inside, refuse to hash).
 */
async function resolvesInsideSources(resolved: string, realSourcesRoot: string): Promise<boolean> {
  try {
    const realFile = await realpath(resolved);
    return realFile === realSourcesRoot || realFile.startsWith(realSourcesRoot + path.sep);
  } catch {
    return false;
  }
}

/**
 * Classify one source entry from state.json, guarding against both path traversal
 * and symlink escapes. A poisoned key like `../../etc/passwd` is rejected by the
 * cheap lexical check (first gate). A symlink inside sources/ pointing outside is
 * rejected by the realpath check (second gate). Both cases return exists:false.
 */
async function classifySource(
  sourcesRoot: string,
  realSourcesRoot: string,
  file: string,
  entry: { hash: string; concepts: string[] },
): Promise<SourceFreshness> {
  const resolved = path.resolve(sourcesRoot, file);
  const lexicallyInside = resolved === sourcesRoot || resolved.startsWith(sourcesRoot + path.sep);
  if (!lexicallyInside) {
    return { recordedHash: entry.hash, currentHash: null, exists: false, concepts: entry.concepts };
  }
  const exists = existsSync(resolved);
  if (exists && !(await resolvesInsideSources(resolved, realSourcesRoot))) {
    // Symlink escapes sources/ — treat as unverifiable, never hash/read it.
    return { recordedHash: entry.hash, currentHash: null, exists: false, concepts: entry.concepts };
  }
  return {
    recordedHash: entry.hash,
    currentHash: exists ? await hashFile(resolved) : null,
    exists,
    concepts: entry.concepts,
  };
}
