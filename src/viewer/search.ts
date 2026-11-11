/**
 * Server-side title/body search over the startup `ViewerSnapshot`.
 *
 * V1 semantics (spec §Slice 5 "Search semantics"):
 *   - case-insensitive
 *   - whitespace-tokenized
 *   - multi-token AND: every token must appear in either title or body
 *   - title matches rank before body matches
 *   - 200-char query cap, 50-result cap
 *   - every page in the snapshot: default concept/query pages AND a
 *     non-default profile's typed entity pages, which reach the list
 *     already filtered to the profile-VALID ones. `wiki/index.md` is
 *     excluded by construction (it never lives in `snapshot.pages`)
 *   - no fuzzy matching, stemming, regex, or client-side search
 *   - a timeline day is matched without its generated "Pages from this day"
 *     list, so it matches on what happened rather than on what it links
 *
 * The search reads from the snapshot exclusively — no per-request disk
 * I/O — so it inherits the same "frozen at startup, restart to refresh"
 * lifecycle as the rest of the viewer's API.
 */

import type { ViewerPage, ViewerPageDirectory, ViewerPageId, ViewerSnapshot } from "./types.js";
import { withoutGenerated } from "../wiki/generated-section.js";

const MAX_QUERY_LENGTH = 200;
const MAX_RESULTS = 50;
const SNIPPET_RADIUS = 60;
const SNIPPET_ELLIPSIS = "…";

/** Where the query matched in a result page. */
type SearchMatch = "title" | "body";

/** One row in the `/api/search` response. */
interface SearchResult {
  id: ViewerPageId;
  pageDirectory: ViewerPageDirectory;
  title: string;
  snippet: string;
  matchedIn: SearchMatch;
  /** Entity type for a typed page; absent on default pages, so default rows are unchanged. */
  entityType?: string;
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
  const body = searchableBody(page);
  const titleLower = page.title.toLowerCase();
  const bodyLower = body.toLowerCase();
  for (const token of tokens) {
    if (!titleLower.includes(token) && !bodyLower.includes(token)) return null;
  }
  const allInTitle = tokens.every((t) => titleLower.includes(t));
  if (allInTitle) return rowFromPage(page, page.title, "title");
  const snippet = buildBodySnippet(body, bodyLower, tokens);
  return rowFromPage(page, snippet, "body");
}

/**
 * The text a page is searched by. A generated tail (a day's "Pages from this
 * day", a person's "Days") lists other pages, not what the page says, so it is
 * left out: a page should match on its own content, not on every page it links to.
 */
function searchableBody(page: ViewerPage): string {
  return withoutGenerated(page.body);
}

/** Assemble a SearchResult from a page + computed snippet. */
function rowFromPage(page: ViewerPage, snippet: string, matchedIn: SearchMatch): SearchResult {
  return {
    id: page.id,
    pageDirectory: page.pageDirectory,
    title: page.title,
    snippet,
    matchedIn,
    ...(page.entityType !== undefined ? { entityType: page.entityType } : {}),
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
  const cut = { start: start > 0, end: end < body.length };
  const cleaned = stripInlineMarkdownNoise(stripCutMarkup(body.slice(start, end), cut))
    .replace(/\s+/g, " ")
    .trim();
  return `${cut.start ? SNIPPET_ELLIPSIS : ""}${cleaned}${cut.end ? SNIPPET_ELLIPSIS : ""}`;
}

/** A citation's file entry: a name with an extension and an optional line range. */
const CITATION_FILE = String.raw`[^\s[\]]+\.[A-Za-z0-9]+(?::[\d-]+)?`;
/** A whole citation marker, `^[a.md:1-2, b.txt]`, or one the window cut off at its end. */
const CITATION_MARKER = new RegExp(String.raw`\^\[${CITATION_FILE}(?:,\s*[^[\]\n]*)?(?:\]|$)`, "g");
/** The tail of a citation marker the window cut off at its start: it runs, bracket-free, to a `file.ext:lines]`. */
const CUT_CITATION_TAIL = /^[^[\]\n]*\.[A-Za-z0-9]+(?::[\d-]+)?\]/;

/**
 * Remove the halves of markup the snippet window cut through: a citation or a
 * wikilink begun before the window opened, or one still open when it closed.
 * Only an edge that was actually cut is touched, so text that merely looks like
 * a fragment (a `|` before a `]]`, a body ending in `[[`) is left alone.
 */
function stripCutMarkup(text: string, cut: { start: boolean; end: boolean }): string {
  let result = text;
  if (cut.start) {
    result = result.replace(CUT_CITATION_TAIL, "").replace(/^[^[\]\n]*\|([^[\]\n]*)\]\]/, "$1").replace(/^[^[\]\n|]*\]\]/, "");
  }
  if (cut.end) {
    result = result.replace(/\^\[[^\]\n]*$/, "").replace(/\[\[[^\]|\n]*\|([^\]\n]*)$/, "$1").replace(/\[\[([^\]|\n]*)$/, "$1");
  }
  return result;
}

/**
 * Strip common inline-markdown markers from a snippet so the search
 * results panel shows readable prose rather than `**keyword**` and
 * `[label](url)` noise: emphasis, links, wikilinks, citation markers (a `^[`
 * followed by a file name, so `^[A-Z]` in a regex survives) and heading markers.
 */
function stripInlineMarkdownNoise(text: string): string {
  return text
    .replace(CITATION_MARKER, "")
    .replace(/(^|\n)\s*#{1,6}\s+/g, "$1")
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
