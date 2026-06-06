/**
 * Computed source-freshness layer.
 *
 * Derives a page's freshness on demand from a FreshnessSnapshot (state.json
 * hashes + current source hashes). Pure — never reads or writes the filesystem
 * and never persists freshness. See localdocs/specs/2026-06-04-source-freshness-design.md.
 */

import type { FreshnessSnapshot, PageFreshness, PageFreshnessInput, FreshnessStatus } from "./types.js";
import { existsSync } from "fs";
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
    for (const [file, entry] of Object.entries(state.sources)) {
      const filePath = path.join(root, SOURCES_DIR, file);
      const exists = existsSync(filePath);
      sources[file] = {
        recordedHash: entry.hash,
        currentHash: exists ? await hashFile(filePath) : null,
        exists,
        concepts: entry.concepts,
      };
    }
  }
  return { stateStatus: status, sources };
}
