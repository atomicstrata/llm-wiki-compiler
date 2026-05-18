/**
 * Server-side title/body search over the startup `ViewerSnapshot`.
 *
 * V1 semantics (spec §Slice 5 "Search semantics"):
 *   - case-insensitive
 *   - whitespace-tokenized
 *   - multi-token AND: every token must appear in either title or body
 *   - title matches rank before body matches
 *   - 200-char query cap, 50-result cap
 *   - concept and query pages only — `wiki/index.md` is excluded by
 *     construction (it never lives in `snapshot.pages`)
 *   - no fuzzy matching, stemming, regex, or client-side search
 *
 * The search reads from the snapshot exclusively — no per-request disk
 * I/O — so it inherits the same "frozen at startup, restart to refresh"
 * lifecycle as the rest of the viewer's API.
 */

import type { PageId, ViewerPage, ViewerSnapshot } from "./types.js";
import type { PageDirectory } from "../export/types.js";

const MAX_QUERY_LENGTH = 200;
const MAX_RESULTS = 50;
const SNIPPET_RADIUS = 60;
const SNIPPET_ELLIPSIS = "…";

/** Where the query matched in a result page. */
type SearchMatch = "title" | "body";

/** One row in the `/api/search` response. */
interface SearchResult {
  id: PageId;
  pageDirectory: PageDirectory;
  title: string;
  snippet: string;
  matchedIn: SearchMatch;
}

/**
 * Run a search over the snapshot and return the results envelope. Pure
 * over `(snapshot, rawQuery)` — the same inputs always produce the same
 * output, which lets the route handler stay a one-line adapter.
 */
export function searchPages(
  snapshot: ViewerSnapshot,
  rawQuery: string,
): { results: SearchResult[] } {
  const tokens = tokenizeQuery(rawQuery);
  if (tokens.length === 0) return { results: [] };
  const matches = collectMatches(snapshot.pages, tokens);
  matches.sort(compareResults);
  return { results: matches.slice(0, MAX_RESULTS) };
}

/**
 * Trim, lowercase, cap at 200 characters, then split on any run of
 * whitespace. Empty tokens are dropped so trailing/leading spaces or
 * a runaway over-cap query still produce sensible tokens.
 */
function tokenizeQuery(rawQuery: string): string[] {
  if (typeof rawQuery !== "string") return [];
  const trimmed = rawQuery.trim();
  if (trimmed.length === 0) return [];
  const capped = trimmed.slice(0, MAX_QUERY_LENGTH).toLowerCase();
  return capped.split(/\s+/).filter((t) => t.length > 0);
}

/** Iterate the snapshot pages and emit one result per match. */
function collectMatches(pages: ReadonlyArray<ViewerPage>, tokens: string[]): SearchResult[] {
  const matches: SearchResult[] = [];
  for (const page of pages) {
    const result = matchPage(page, tokens);
    if (result) matches.push(result);
  }
  return matches;
}

/**
 * Decide whether `page` matches `tokens`. Per spec §Slice 5 Search
 * Semantics: "every token must appear in title or body" — each token
 * individually must appear in the title-or-body union. Classification
 * (`matchedIn`) is "title" only when every token is found in the title;
 * any token that only matched the body downgrades the page to a body
 * hit, which then ranks below title hits.
 */
function matchPage(page: ViewerPage, tokens: string[]): SearchResult | null {
  const titleLower = page.title.toLowerCase();
  const bodyLower = page.body.toLowerCase();
  for (const token of tokens) {
    if (!titleLower.includes(token) && !bodyLower.includes(token)) return null;
  }
  const allInTitle = tokens.every((t) => titleLower.includes(t));
  if (allInTitle) return rowFromPage(page, page.title, "title");
  const snippet = buildBodySnippet(page.body, bodyLower, tokens);
  return rowFromPage(page, snippet, "body");
}

/** Assemble a SearchResult from a page + computed snippet. */
function rowFromPage(page: ViewerPage, snippet: string, matchedIn: SearchMatch): SearchResult {
  return {
    id: page.id,
    pageDirectory: page.pageDirectory,
    title: page.title,
    snippet,
    matchedIn,
  };
}

/**
 * Extract ±SNIPPET_RADIUS chars around the earliest token match in the
 * body. Newlines are flattened to single spaces so the snippet renders
 * inline in the results panel. `…` is prepended/appended when the
 * window was truncated at either end.
 */
function buildBodySnippet(body: string, bodyLower: string, tokens: string[]): string {
  const matchPos = earliestTokenPosition(bodyLower, tokens);
  const start = Math.max(0, matchPos - SNIPPET_RADIUS);
  const end = Math.min(body.length, matchPos + SNIPPET_RADIUS);
  const cleaned = stripInlineMarkdownNoise(body.slice(start, end))
    .replace(/\s+/g, " ")
    .trim();
  const prefix = start > 0 ? SNIPPET_ELLIPSIS : "";
  const suffix = end < body.length ? SNIPPET_ELLIPSIS : "";
  return `${prefix}${cleaned}${suffix}`;
}

/**
 * Strip common inline-markdown markers from a snippet so the search
 * results panel shows readable prose rather than `**keyword**` and
 * `[label](url)` noise. Intentionally narrow: only handles the
 * inline-marker forms a reader would mistake for typos. Block-level
 * markers (`#` headings, `>` blockquotes) are left alone — they sit at
 * the start of a line and rarely land inside a ±60-char window.
 */
function stripInlineMarkdownNoise(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, "$2")
    .replace(/\[\[([^\]\n]+)\]\]/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "$1")
    .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1");
}

/** Earliest index where any token first appears in the body. */
function earliestTokenPosition(bodyLower: string, tokens: string[]): number {
  let earliest = bodyLower.length;
  for (const token of tokens) {
    const idx = bodyLower.indexOf(token);
    if (idx >= 0 && idx < earliest) earliest = idx;
  }
  return earliest;
}

/**
 * Title hits sort before body hits. Within the same `matchedIn` bucket
 * the order is stable by title (alphabetical, locale-aware) so the
 * result list does not shift between requests against the same snapshot.
 */
function compareResults(a: SearchResult, b: SearchResult): number {
  if (a.matchedIn !== b.matchedIn) {
    return a.matchedIn === "title" ? -1 : 1;
  }
  return a.title.localeCompare(b.title);
}
