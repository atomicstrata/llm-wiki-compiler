/**
 * Read-only project-status collector shared by the MCP `wiki_status` tool and the in-process SDK.
 *
 * Derives stale/orphaned page classification from the freshness module so
 * agents get source-level accuracy rather than frontmatter-only orphans.
 * Uses `readStateClassified` throughout — never `readState` — so corrupt
 * state.json never produces a `.bak` side-effect.
 *
 * `pendingChanges` is derived directly from the freshness snapshot (which
 * already has per-source currentHash/recordedHash/exists) plus a cheap
 * directory listing — no second hash pass. `detectChanges` is NOT called.
 */

import path from "path";
import { readdir } from "fs/promises";
import { collectPageSummaries, scanWikiPages } from "../compiler/indexgen.js";
import { countCandidates } from "../compiler/candidates.js";
import { readStateClassified, isPlainObject } from "../utils/state.js";
import type { StateStatus } from "../utils/state.js";
import { buildFreshnessSnapshot, computeFreshness } from "../freshness/index.js";
import { CONCEPTS_DIR, QUERIES_DIR, SOURCES_DIR } from "../utils/constants.js";
import { collectProfileSummary } from "../profile/block.js";
import { journalHealthWarning } from "../trust/journal-health-warning.js";
import type { ReadSurfaceWarning } from "../trust/journal-health-warning.js";
import { pendingEmbeddingsWarning } from "../trust/pending-embeddings-warning.js";
import type { FreshnessSnapshot } from "../freshness/types.js";
import type { EntityProblemView } from "../profile/types.js";

/**
 * Maximum number of items returned in each agent-facing list (stalePages,
 * orphanedPages, pendingChanges). Bounds the MCP response size and agent
 * context consumption on large wikis. True totals are in the matching *Count fields.
 */
export const MAX_STATUS_LIST = 100;

/** Shape returned by `collectStatus` and surfaced by the `wiki_status` tool. */
export interface WikiStatus {
  pages: { concepts: number; queries: number; total: number };
  sources: number;
  lastCompiledAt: string | null;
  /**
   * Concept slugs whose source changed or partially disappeared since compile.
   * Capped at MAX_STATUS_LIST (sorted ascending); see staleCount for the true total.
   */
  stalePages: string[];
  /** True total of stale pages (may exceed stalePages.length when capped). */
  staleCount: number;
  /**
   * Concept slugs whose every owning source was deleted, or frontmatter-flagged orphaned.
   * Capped at MAX_STATUS_LIST (sorted ascending); see orphanedCount for the true total.
   */
  orphanedPages: string[];
  /** True total of orphaned pages (may exceed orphanedPages.length when capped). */
  orphanedCount: number;
  /**
   * Readability of .llmwiki/state.json — surfaced so corrupt OR too-new state
   * (written by a newer llmwiki) is never silently reported as healthy.
   */
  stateStatus: StateStatus;
  /** Number of compile candidates awaiting human review. */
  pendingCandidates: number;
  /**
   * Source files with changes since last compile (new/changed/deleted).
   * Capped at MAX_STATUS_LIST (sorted by file); see pendingChangesCount for the true total.
   */
  pendingChanges: Array<{ file: string; status: string }>;
  /** True total of pending changes (may exceed pendingChanges.length when capped). */
  pendingChangesCount: number;
  /**
   * Read-surface health warnings carried alongside the status payload. ABSENT
   * (key omitted) for a healthy project, so a clean status envelope is
   * byte-identical (parity-safe); present ONLY when the journal is `pending`
   * (`incomplete-compile`) or `unavailable` (`journal-unavailable`), or when an
   * embeddings refresh is still pending (`embeddings-refresh-pending`), so partial
   * post-crash / tampered state OR a skipped embeddings update is never reported as
   * silently healthy. Mirrors the journal-warning surfacing on viewer/export/context.
   */
  warnings?: ReadSurfaceWarning[];
  /**
   * Active non-default profile summary. ABSENT (undefined) for the default
   * profile so default envelopes are unchanged. When present, `entityCounts`
   * is the per-entity-type page count; the legacy `pages` block above stays
   * scoped to the literal wiki/concepts + wiki/queries dirs only.
   */
  profile?: {
    profileId: string;
    digest: string;
    entityCounts: Record<string, number>;
    /**
     * Structured problems from the non-default read path (invalid directories,
     * non-slug-safe filenames, slug mismatches, field-contract violations),
     * CAPPED at PROFILE_PROBLEM_CAP; each `path` is project-relative (never
     * absolute) and absent for directory-level problems. Present ONLY when
     * non-empty, so a non-default project with a bad directory or page is never
     * reported as silently healthy; see `problemTotal` for the full count.
     */
    problems?: EntityProblemView[];
    /** Full problem count (may exceed `problems.length` when capped). */
    problemTotal?: number;
    /**
     * Per-entity-type tally of the CURRENT lifecycle-field value across that
     * type's enrolled pages (e.g. `{ ideas: { proposed: 1, testing: 2 } }`),
     * computed ONLY for entity types declaring a `lifecycle`, from the bounded
     * frontmatter-only scan. This is what makes a lifecycle TRANSITION visible
     * to `status`/`wiki_status`: a field-flip changes these counts. ABSENT when
     * no entity type declares a lifecycle (or none is enrolled), so default and
     * lifecycle-less envelopes stay byte-identical.
     */
    lifecycleStates?: Record<string, Record<string, number>>;
  };
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

/**
 * Derive the last compile time from state sources, or null if no sources.
 * Belt-and-suspenders: a non-plain-object `sources` (e.g. a too-new state with
 * no v1-shaped map) is coerced to `{}` so no caller can crash this read.
 */
function lastCompileTime(sources: Record<string, { compiledAt: string }>): string | null {
  const safe = isPlainObject(sources) ? sources : {};
  const times = Object.values(safe).map((s) => s.compiledAt);
  return times.length > 0 ? times.sort().slice(-1)[0] : null;
}

/** List markdown filenames in sources/ without hashing — cheap directory scan. */
async function listSourceFilesOnDisk(root: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(root, SOURCES_DIR));
    return entries.filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

/**
 * Derive pending source changes (new/changed/deleted) from the freshness snapshot — no extra hashing.
 * The snapshot already contains recordedHash, currentHash, and exists for each tracked source,
 * so we only need a cheap directory listing to discover untracked (new) files.
 */
function pendingChangesFromSnapshot(
  snapshot: FreshnessSnapshot,
  sourceFilesOnDisk: string[],
): Array<{ file: string; status: string }> {
  const out: Array<{ file: string; status: string }> = [];
  for (const [file, s] of Object.entries(snapshot.sources)) {
    if (!s.exists) out.push({ file, status: "deleted" });
    else if (s.currentHash !== s.recordedHash) out.push({ file, status: "changed" });
  }
  const recorded = new Set(Object.keys(snapshot.sources));
  for (const file of sourceFilesOnDisk) {
    if (!recorded.has(file)) out.push({ file, status: "new" });
  }
  return out;
}

/**
 * Sort a slug list ascending and cap it at MAX_STATUS_LIST.
 * Deterministic truncation ensures agents see the same subset on repeated calls.
 */
function capSlugs(slugs: string[]): string[] {
  return slugs.slice().sort().slice(0, MAX_STATUS_LIST);
}

/**
 * Sort a pending-change list by file name ascending and cap at MAX_STATUS_LIST.
 * Deterministic truncation matches capSlugs behaviour for consistency.
 */
function capPendingChanges(
  changes: Array<{ file: string; status: string }>,
): Array<{ file: string; status: string }> {
  return changes.slice().sort((a, b) => a.file.localeCompare(b.file)).slice(0, MAX_STATUS_LIST);
}

/** Build a read-only status snapshot used by the `wiki_status` MCP tool. */
export async function collectStatus(root: string): Promise<WikiStatus> {
  const classified = await readStateClassified(root);
  const snapshot = await buildFreshnessSnapshot(root, classified);

  const [conceptSummaries, queries, scannedConcepts, pendingCandidates, sourceFilesOnDisk] = await Promise.all([
    collectPageSummaries(path.join(root, CONCEPTS_DIR)),
    collectPageSummaries(path.join(root, QUERIES_DIR)),
    scanWikiPages(path.join(root, CONCEPTS_DIR)),
    countCandidates(root),
    listSourceFilesOnDisk(root),
  ]);

  const { stalePages, orphanedPages } = classifyConceptPages(scannedConcepts, snapshot);
  const profileBlock = await collectProfileSummary(root);
  // Surface read-surface health signals so an agent never reads a degraded status
  // as silently healthy: a pending/unavailable journal (unfinished or tampered
  // compile) AND a pending embeddings refresh (a compile that skipped/failed the
  // embeddings update). Each mapper returns null when healthy, so the combined
  // array is empty for a clean project and the field stays absent (parity-safe).
  const [journalWarning, pendingWarning] = await Promise.all([
    journalHealthWarning(root),
    pendingEmbeddingsWarning(root),
  ]);
  const warnings = [journalWarning, pendingWarning].filter(
    (w): w is ReadSurfaceWarning => w !== null,
  );

  // Suppress pendingChanges when state is corrupt OR too-new: comparing against an
  // empty snapshot would classify every source file as "new", which is false precision
  // (and would make a too-new project look like an ordinary fresh checkout).
  // On missing state the snapshot is legitimately empty, so every on-disk source is "new" — correct.
  const stateUnusable = classified.status === "corrupt" || classified.status === "too-new";
  const pendingChanges = stateUnusable
    ? []
    : pendingChangesFromSnapshot(snapshot, sourceFilesOnDisk);

  // A too-new state carries the RAW parsed object, which need not be v1-shaped:
  // its `sources` may be absent. Fail closed by reading an empty map for any
  // unusable state, so the source count and last-compile reads cannot crash.
  const usableSources = stateUnusable ? {} : classified.state.sources;

  return {
    pages: { concepts: conceptSummaries.length, queries: queries.length, total: conceptSummaries.length + queries.length },
    sources: Object.keys(usableSources).length,
    lastCompiledAt: lastCompileTime(usableSources),
    stalePages: capSlugs(stalePages),
    staleCount: stalePages.length,
    orphanedPages: capSlugs(orphanedPages),
    orphanedCount: orphanedPages.length,
    stateStatus: classified.status,
    pendingCandidates,
    pendingChanges: capPendingChanges(pendingChanges),
    pendingChangesCount: pendingChanges.length,
    ...(warnings.length ? { warnings } : {}),
    ...(profileBlock ? { profile: profileBlock } : {}),
  };
}
