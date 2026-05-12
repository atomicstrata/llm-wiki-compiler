/**
 * Build the `/api/health` response from the frozen startup snapshot.
 *
 * The only per-request filesystem read is `readLintCache(root)` — every
 * other count is captured at startup in `ViewerSnapshot`. The lint cache
 * is intentionally read per-request because PR #57 already designed it
 * as a tiny atomic JSON file the viewer's contract treats as a stable
 * surface (returns `null` when no lint run has completed yet).
 */

import { readLintCache } from "../linter/cache.js";
import type { LintCacheEntry } from "../linter/cache.js";
import type { ViewerSnapshot } from "./types.js";

/**
 * Cheap health summary surfacing the same count fields MCP `wiki_status`
 * uses, plus the lint cache. Shapes diverge intentionally — MCP returns
 * an envelope with nested `pages`, the viewer returns a flat record for
 * the dashboard.
 */
interface ViewerHealthResponse {
  pendingReviews: number;
  sources: number;
  sourceFiles: number;
  concepts: number;
  queries: number;
  lint: LintCacheEntry | null;
}

/**
 * Assemble the health response. Reads `.llmwiki/last-lint.json` via
 * `readLintCache`; every other value is derived from the snapshot's
 * frozen counts.
 */
export async function buildHealthResponse(
  snapshot: ViewerSnapshot,
): Promise<ViewerHealthResponse> {
  const lint = await readLintCache(snapshot.root);
  return {
    pendingReviews: snapshot.counts.pendingReviews,
    sources: snapshot.counts.compiledSources,
    sourceFiles: snapshot.counts.sourceFiles,
    concepts: snapshot.counts.concepts,
    queries: snapshot.counts.queries,
    lint,
  };
}
