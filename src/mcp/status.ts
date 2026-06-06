/**
 * Read-only project-status collector for the MCP `wiki_status` tool.
 *
 * Derives stale/orphaned page classification from the freshness module so
 * agents get source-level accuracy rather than frontmatter-only orphans.
 * Uses `readStateClassified` throughout — never `readState` — so corrupt
 * state.json never produces a `.bak` side-effect.
 */

import path from "path";
import { collectPageSummaries, scanWikiPages } from "../compiler/indexgen.js";
import { detectChanges } from "../compiler/hasher.js";
import { countCandidates } from "../compiler/candidates.js";
import { readStateClassified } from "../utils/state.js";
import { buildFreshnessSnapshot, computeFreshness } from "../freshness/index.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import type { FreshnessSnapshot } from "../freshness/types.js";

/** Shape returned by `collectStatus` and surfaced by the `wiki_status` tool. */
export interface WikiStatus {
  pages: { concepts: number; queries: number; total: number };
  sources: number;
  lastCompiledAt: string | null;
  /** Concept slugs whose source changed or partially disappeared since compile. */
  stalePages: string[];
  /** Concept slugs whose every owning source was deleted, or frontmatter-flagged orphaned (superset of old behavior). */
  orphanedPages: string[];
  /** Readability of .llmwiki/state.json — surfaced so corrupt state is never silent. */
  stateStatus: "ok" | "missing" | "corrupt";
  /** Number of compile candidates awaiting human review. */
  pendingCandidates: number;
  pendingChanges: Array<{ file: string; status: string }>;
}

/** Classify scanned concept pages into stale/orphaned arrays using the freshness snapshot. */
function classifyConceptPages(
  scanned: { slug: string; meta: Record<string, unknown> }[],
  snapshot: FreshnessSnapshot,
): { stalePages: string[]; orphanedPages: string[] } {
  const stalePages: string[] = [];
  const orphanedPages: string[] = [];
  for (const { slug, meta } of scanned) {
    const { freshnessStatus } = computeFreshness(
      { slug, pageDirectory: "concepts", frontmatter: meta },
      snapshot,
    );
    if (freshnessStatus === "stale") stalePages.push(slug);
    else if (freshnessStatus === "orphaned") orphanedPages.push(slug);
  }
  return { stalePages, orphanedPages };
}

/** Derive the last compile time from state sources, or null if no sources. */
function lastCompileTime(sources: Record<string, { compiledAt: string }>): string | null {
  const times = Object.values(sources).map((s) => s.compiledAt);
  return times.length > 0 ? times.sort().slice(-1)[0] : null;
}

/** Build a read-only status snapshot used by the `wiki_status` MCP tool. */
export async function collectStatus(root: string): Promise<WikiStatus> {
  const classified = await readStateClassified(root);
  const snapshot = await buildFreshnessSnapshot(root, classified);
  const conceptSummaries = await collectPageSummaries(path.join(root, CONCEPTS_DIR));
  const queries = await collectPageSummaries(path.join(root, QUERIES_DIR));
  const scannedConcepts = await scanWikiPages(path.join(root, CONCEPTS_DIR));

  const { stalePages, orphanedPages } = classifyConceptPages(scannedConcepts, snapshot);
  const changes = await detectChanges(root, classified.state);

  return {
    pages: { concepts: conceptSummaries.length, queries: queries.length, total: conceptSummaries.length + queries.length },
    sources: Object.keys(classified.state.sources).length,
    lastCompiledAt: lastCompileTime(classified.state.sources),
    stalePages,
    orphanedPages,
    stateStatus: classified.status,
    pendingCandidates: await countCandidates(root),
    pendingChanges: changes.filter((c) => c.status !== "unchanged").map((c) => ({ file: c.file, status: c.status })),
  };
}
