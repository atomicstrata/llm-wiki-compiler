/**
 * Shared read-only status collector for llmwiki.
 *
 * Exposes `collectStatus` (and its helpers `WikiStatus` interface and
 * `findOrphanedSlugs`) for consumption by both the MCP server (`tools.ts`)
 * and the in-process SDK.  This module is intentionally free of side effects:
 * it uses `readStateClassified` instead of `readState`, so a corrupt
 * state.json never causes a `.bak` write or a `console.warn`.
 */

import path from "path";
import { collectPageSummaries, scanWikiPages } from "../compiler/indexgen.js";
import { detectChanges } from "../compiler/hasher.js";
import { countCandidates } from "../compiler/candidates.js";
import { readStateClassified } from "../utils/state.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import type { SourceChange } from "../utils/types.js";

/**
 * A source change that is actually pending: `"unchanged"` entries are
 * filtered out by `collectStatus`, so only these three statuses remain.
 */
type PendingChange = SourceChange & { status: Exclude<SourceChange["status"], "unchanged"> };

/** Read-only status snapshot returned by `collectStatus`. */
export interface WikiStatus {
  pages: { concepts: number; queries: number; total: number };
  sources: number;
  lastCompiledAt: string | null;
  orphanedPages: string[];
  /** Number of compile candidates awaiting human review. */
  pendingCandidates: number;
  pendingChanges: Array<{ file: string; status: PendingChange["status"] }>;
}

/** Find concept slugs whose pages are flagged as orphaned. */
async function findOrphanedSlugs(root: string): Promise<string[]> {
  const scanned = await scanWikiPages(path.join(root, CONCEPTS_DIR));
  return scanned.filter(({ meta }) => meta.orphaned).map(({ slug }) => slug);
}

/** Read-only status snapshot used by the wiki_status tool and SDK. */
export async function collectStatus(root: string): Promise<WikiStatus> {
  const concepts = await collectPageSummaries(path.join(root, CONCEPTS_DIR));
  const queries = await collectPageSummaries(path.join(root, QUERIES_DIR));
  const { state } = await readStateClassified(root);
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
      .filter((c): c is PendingChange => c.status !== "unchanged")
      .map((c) => ({ file: c.file, status: c.status })),
  };
}
