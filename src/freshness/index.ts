/**
 * Computed source-freshness layer (radar P0).
 *
 * Derives a page's freshness on demand from a FreshnessSnapshot (state.json
 * hashes + current source hashes). Pure — never reads or writes the filesystem
 * and never persists freshness. See localdocs/specs/2026-06-04-source-freshness-design.md.
 */

import type { FreshnessSnapshot, PageFreshness, PageFreshnessInput, FreshnessStatus } from "./types.js";

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
  if (page.frontmatter.orphaned === true) return "orphaned";
  if (page.pageDirectory === "queries") return "unverified";

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
