/**
 * Lexical-only ranking for Slice 1 of `llmwiki context`.
 *
 * Slice 1 deliberately avoids semantic retrieval — `findRelevantChunks`
 * needs a provider to embed the query, and Slice 1 must work without
 * credentials. Slice 2 layers semantic on top of the same combiner
 * (plan §Ranking Model).
 *
 * Signals fed into the combiner:
 *   - `searchPages().results[].matchedIn` distinguishes title vs body
 *     hits without re-parsing the body.
 *   - Exact slug equality (case-insensitive after lowercasing) adds a
 *     strong bonus and the `exact-slug` reason.
 *   - Exact title equality (case-insensitive, trimmed) adds the
 *     strongest bonus and the `exact-title` reason.
 *
 * Scores are normalized into [0, 1] best-effort — they're explainable
 * to the agent but not a quality guarantee. Stable tie-sort: descending
 * score, then ascending title, then ascending page ID.
 */

import { searchPages } from "../viewer/search.js";
import type { ViewerPage, ViewerSnapshot } from "../viewer/types.js";
import type { ContextPrimary, PrimaryReason } from "./types.js";

/** Per-signal weight (sums normalize so an exact-title hit lands near 1.0). */
const WEIGHT_TITLE_MATCH = 0.5;
const WEIGHT_BODY_MATCH = 0.3;
const WEIGHT_EXACT_SLUG = 0.4;
const WEIGHT_EXACT_TITLE = 0.5;

/** Cap so combined scores stay inside the normalized [0, 1] range. */
const MAX_NORMALIZED_SCORE = 1;

/** Internal accumulator: one row per candidate page. */
interface RankingRow {
  page: ViewerPage;
  reasons: Set<PrimaryReason>;
  weight: number;
  snippet: string;
}

/**
 * Rank candidate pages for `prompt` against `snapshot`, returning up to
 * `topN` populated {@link ContextPrimary} entries. Slice-1-only fields
 * are placeholders: `chunks`, `citations`, `sourceWindows` are empty
 * arrays. Page-local `warnings` is sourced from the viewer collector.
 */
export function rankPages(
  snapshot: ViewerSnapshot,
  prompt: string,
  topN: number,
): ContextPrimary[] {
  const rows = new Map<string, RankingRow>();
  applyLexicalSignals(rows, snapshot, prompt);
  applyExactSignals(rows, snapshot, prompt);
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

/** Fetch the row for `page`, lazily allocating it on first use. */
function ensureRow(rows: Map<string, RankingRow>, page: ViewerPage): RankingRow {
  const existing = rows.get(page.id);
  if (existing) return existing;
  const created: RankingRow = { page, reasons: new Set(), weight: 0, snippet: "" };
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

/** Convert a ranking row into a Slice-1 ContextPrimary with placeholder later-slice fields. */
function rowToPrimary(row: RankingRow): ContextPrimary {
  return {
    id: row.page.id,
    title: row.page.title,
    pageDirectory: row.page.pageDirectory,
    score: normalizeWeight(row.weight),
    reasons: Array.from(row.reasons).sort(),
    summary: row.snippet,
    chunks: [],
    citations: [],
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
