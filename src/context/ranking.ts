/**
 * Multi-signal ranking for `llmwiki context`.
 *
 * Slice 1 wired lexical + exact-match signals. Slice 2 layers semantic
 * chunk retrieval on top of the same combiner (plan §Ranking Model);
 * the wrapper in `src/context/retrieval.ts` keeps the orchestrator
 * unaware of whether the embedding store contributed.
 *
 * Signals fed into the combiner:
 *   - `searchPages().results[].matchedIn` distinguishes title vs body
 *     hits without re-parsing the body.
 *   - Exact slug equality (case-insensitive after lowercasing) adds a
 *     strong bonus and the `exact-slug` reason.
 *   - Exact title equality (case-insensitive, trimmed) adds the
 *     strongest bonus and the `exact-title` reason.
 *   - Semantic chunk hits add a high-weight `semantic-chunk` reason
 *     and attach the chunk text/score/contentHash to the primary page;
 *     additional chunks on the same page contribute a capped bonus so
 *     a popular page can't shadow exact-title hits.
 *
 * Scores are normalized into [0, 1] best-effort — they're explainable
 * to the agent but not a quality guarantee. Stable tie-sort: descending
 * score, then ascending title, then ascending page ID.
 */

import { searchPages } from "../viewer/search.js";
import type { ViewerPage, ViewerSnapshot } from "../viewer/types.js";
import type { SemanticChunkHit } from "./retrieval.js";
import { flattenCitations } from "./provenance.js";
import type { ContextPrimary, PrimaryReason } from "./types.js";

/** Per-signal weight (sums normalize so an exact-title hit lands near 1.0). */
const WEIGHT_TITLE_MATCH = 0.5;
const WEIGHT_BODY_MATCH = 0.3;
const WEIGHT_EXACT_SLUG = 0.4;
const WEIGHT_EXACT_TITLE = 0.5;

/** Base weight for the first semantic chunk a page contributes. Peer of title-match. */
const WEIGHT_SEMANTIC_CHUNK = 0.5;
/** Per-additional-chunk bonus once the first semantic hit on a page has landed. */
const WEIGHT_SEMANTIC_CHUNK_BONUS = 0.05;
/** Max additional chunks (beyond the first) that contribute the per-chunk bonus. */
const MAX_SEMANTIC_BONUS_CHUNKS = 3;

/** Cap so combined scores stay inside the normalized [0, 1] range. */
const MAX_NORMALIZED_SCORE = 1;

/**
 * One semantic chunk surfaced for a primary page. Matches the inline
 * `ContextPrimary.chunks[]` shape in `types.ts`; declared locally so the
 * ranker can build it without exporting the structural anonymous type.
 */
interface PrimaryChunk {
  text: string;
  score: number;
  contentHash: string;
}

/** Internal accumulator: one row per candidate page. */
interface RankingRow {
  page: ViewerPage;
  reasons: Set<PrimaryReason>;
  weight: number;
  snippet: string;
  /** Chunks attached by `applySemanticSignals`; empty in lexical-only flows. */
  chunks: PrimaryChunk[];
}

/**
 * Rank candidate pages for `prompt` against `snapshot`, returning up to
 * `topN` populated {@link ContextPrimary} entries.
 *
 * `semanticHits` is the post-retrieval chunk list from Slice 2; pass an
 * empty array (the default) for lexical-only behaviour. Citations and
 * sourceWindows stay empty in Slice 2 — those fields land in Slice 4.
 * Page-local `warnings` is sourced from the viewer collector.
 */
export function rankPages(
  snapshot: ViewerSnapshot,
  prompt: string,
  topN: number,
  semanticHits: SemanticChunkHit[] = [],
): ContextPrimary[] {
  const rows = new Map<string, RankingRow>();
  applyLexicalSignals(rows, snapshot, prompt);
  applyExactSignals(rows, snapshot, prompt);
  applySemanticSignals(rows, snapshot, semanticHits);
  const sorted = Array.from(rows.values()).sort(compareRows);
  return sorted.slice(0, Math.max(0, topN)).map(rowToPrimary);
}

/** Push every `searchPages()` hit into the ranking map. */
function applyLexicalSignals(
  rows: Map<string, RankingRow>,
  snapshot: ViewerSnapshot,
  prompt: string,
): void {
  const { results } = searchPages(snapshot, prompt);
  for (const result of results) {
    const page = snapshot.pages.find((p) => p.id === result.id);
    if (!page) continue;
    const row = ensureRow(rows, page);
    row.snippet = row.snippet || result.snippet;
    if (result.matchedIn === "title") {
      addReason(row, "title-match", WEIGHT_TITLE_MATCH);
    } else {
      addReason(row, "body-match", WEIGHT_BODY_MATCH);
    }
  }
}

/** Bonus pass for exact-slug and exact-title matches across all pages. */
function applyExactSignals(
  rows: Map<string, RankingRow>,
  snapshot: ViewerSnapshot,
  prompt: string,
): void {
  const normalized = prompt.trim().toLowerCase();
  if (normalized.length === 0) return;
  for (const page of snapshot.pages) {
    if (page.slug.toLowerCase() === normalized) {
      addReason(ensureRow(rows, page), "exact-slug", WEIGHT_EXACT_SLUG);
    }
    if (page.title.trim().toLowerCase() === normalized) {
      addReason(ensureRow(rows, page), "exact-title", WEIGHT_EXACT_TITLE);
    }
  }
}

/**
 * Apply semantic chunk signals: each retrieved chunk is grouped by page
 * slug, the page gets the `semantic-chunk` reason once, a capped
 * multi-chunk bonus accrues for additional chunks on the same page, and
 * the chunk records are attached to the row for `primary[].chunks[]`.
 *
 * Chunks for slugs that no longer exist in the viewer snapshot are
 * dropped silently — the embedding store can lag behind page deletions
 * and we don't want to fabricate a phantom primary entry just because
 * the store carries a stale chunk.
 */
function applySemanticSignals(
  rows: Map<string, RankingRow>,
  snapshot: ViewerSnapshot,
  hits: SemanticChunkHit[],
): void {
  if (hits.length === 0) return;
  const bySlug = groupHitsBySlug(hits);
  for (const [slug, slugHits] of bySlug) {
    const page = findPageBySlug(snapshot, slug);
    if (!page) continue;
    const row = ensureRow(rows, page);
    addReason(row, "semantic-chunk", WEIGHT_SEMANTIC_CHUNK);
    row.weight += semanticMultiChunkBonus(slugHits.length);
    for (const hit of slugHits) {
      row.chunks.push({
        text: hit.text,
        score: hit.score,
        contentHash: hit.contentHash,
      });
    }
  }
}

/** Group chunk hits by page slug while preserving the score-desc input order. */
function groupHitsBySlug(hits: SemanticChunkHit[]): Map<string, SemanticChunkHit[]> {
  const bySlug = new Map<string, SemanticChunkHit[]>();
  for (const hit of hits) {
    const existing = bySlug.get(hit.slug);
    if (existing) existing.push(hit);
    else bySlug.set(hit.slug, [hit]);
  }
  return bySlug;
}

/** Score bump for the 2nd..N-th chunk on the same page, capped. */
function semanticMultiChunkBonus(chunkCount: number): number {
  const extra = Math.max(0, Math.min(chunkCount - 1, MAX_SEMANTIC_BONUS_CHUNKS));
  return extra * WEIGHT_SEMANTIC_CHUNK_BONUS;
}

/**
 * Resolve a bare chunk slug to a snapshot page, with concepts winning
 * over queries when both contain the same slug — matches the bare-slug
 * precedence rule used by the viewer's wikilink resolver.
 */
function findPageBySlug(snapshot: ViewerSnapshot, slug: string): ViewerPage | null {
  const concept = snapshot.pages.find(
    (p) => p.pageDirectory === "concepts" && p.slug === slug,
  );
  if (concept) return concept;
  const query = snapshot.pages.find(
    (p) => p.pageDirectory === "queries" && p.slug === slug,
  );
  return query ?? null;
}

/** Fetch the row for `page`, lazily allocating it on first use. */
function ensureRow(rows: Map<string, RankingRow>, page: ViewerPage): RankingRow {
  const existing = rows.get(page.id);
  if (existing) return existing;
  const created: RankingRow = {
    page,
    reasons: new Set(),
    weight: 0,
    snippet: "",
    chunks: [],
  };
  rows.set(page.id, created);
  return created;
}

/** Record one reason + weight; reasons set de-dupes naturally. */
function addReason(row: RankingRow, reason: PrimaryReason, weight: number): void {
  row.reasons.add(reason);
  row.weight += weight;
}

/** Stable sort: descending score, ascending title, ascending page ID. */
function compareRows(a: RankingRow, b: RankingRow): number {
  if (a.weight !== b.weight) return b.weight - a.weight;
  const byTitle = a.page.title.localeCompare(b.page.title);
  if (byTitle !== 0) return byTitle;
  return a.page.id.localeCompare(b.page.id);
}

/**
 * Convert a ranking row into a ContextPrimary.
 *
 * Slice 4 fills `citations` from the viewer collector's already-parsed
 * `ClaimCitation[]` (one object per source span, paragraph-only spans
 * keep no line range, multi-source markers split, deduped by
 * `(file,start,end)`, document-order preserved).
 *
 * Page-local `warnings` was wired in Slice 1; it forwards the same
 * `ViewerWarning` objects the viewer surfaces, so any malformed-frontmatter
 * or unresolved-citation diagnostic the viewer already knows about
 * lands in the context pack automatically.
 *
 * `sourceWindows` stays empty here — the orchestrator owns the
 * per-pack budget and writes windows back into the primary entries
 * after ranking, so the ranker remains a pure function over the
 * snapshot.
 */
function rowToPrimary(row: RankingRow): ContextPrimary {
  return {
    id: row.page.id,
    title: row.page.title,
    pageDirectory: row.page.pageDirectory,
    score: normalizeWeight(row.weight),
    reasons: Array.from(row.reasons).sort(),
    summary: row.snippet,
    chunks: row.chunks,
    citations: flattenCitations(row.page.citations),
    sourceWindows: [],
    warnings: row.page.warnings.map((w) => ({ code: w.code, message: w.message })),
  };
}

/** Squash accumulated weight into [0, 1] without inventing precision. */
function normalizeWeight(weight: number): number {
  if (weight <= 0) return 0;
  if (weight >= MAX_NORMALIZED_SCORE) return MAX_NORMALIZED_SCORE;
  return Math.round(weight * 100) / 100;
}
