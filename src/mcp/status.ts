/**
 * Read-only project-status collector for the MCP `wiki_status` tool.
 *
 * Extracted from tools.ts to keep that file under the 400-line limit and to
 * own the (soon-to-be freshness-derived) stale/orphaned classification.
 * All functions here are pure reads — nothing in this module mutates the
 * workspace.
 */

import path from "path";
import { collectPageSummaries, scanWikiPages } from "../compiler/indexgen.js";
import { detectChanges } from "../compiler/hasher.js";
import { countCandidates } from "../compiler/candidates.js";
import { readState } from "../utils/state.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";

/** Shape returned by `collectStatus` and surfaced by the `wiki_status` tool. */
export interface WikiStatus {
  pages: { concepts: number; queries: number; total: number };
  sources: number;
  lastCompiledAt: string | null;
  orphanedPages: string[];
  /** Number of compile candidates awaiting human review. */
  pendingCandidates: number;
  pendingChanges: Array<{ file: string; status: string }>;
}

/** Find concept slugs whose pages are flagged as orphaned. */
async function findOrphanedSlugs(root: string): Promise<string[]> {
  const scanned = await scanWikiPages(path.join(root, CONCEPTS_DIR));
  return scanned.filter(({ meta }) => meta.orphaned).map(({ slug }) => slug);
}

/** Build a read-only status snapshot used by the `wiki_status` MCP tool. */
export async function collectStatus(root: string): Promise<WikiStatus> {
  const concepts = await collectPageSummaries(path.join(root, CONCEPTS_DIR));
  const queries = await collectPageSummaries(path.join(root, QUERIES_DIR));
  const state = await readState(root);
  const changes = await detectChanges(root, state);
  const orphans = await findOrphanedSlugs(root);
  const pendingCandidates = await countCandidates(root);
  const compileTimes = Object.values(state.sources).map((s) => s.compiledAt);
  const lastCompile = compileTimes.length > 0
    ? compileTimes.sort().slice(-1)[0]
    : null;

  return {
    pages: { concepts: concepts.length, queries: queries.length, total: concepts.length + queries.length },
    sources: Object.keys(state.sources).length,
    lastCompiledAt: lastCompile,
    orphanedPages: orphans,
    pendingCandidates,
    pendingChanges: changes
      .filter((c) => c.status !== "unchanged")
      .map((c) => ({ file: c.file, status: c.status })),
  };
}
