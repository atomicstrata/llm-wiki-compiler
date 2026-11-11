/**
 * What the command palette lists and in what order, kept free of React and
 * the DOM so it can be tested directly.
 *
 * Pages are ranked in the browser from the page list the shell already holds:
 * every query word must match, a title beats a summary, a word start beats the
 * middle of a word, and a scattered subsequence ("fsep" for "Founder
 * Separation") still counts, below both, but only in a title and only when
 * each letter continues the previous match or starts a word: without that, a
 * long title or summary holds nearly any word as scattered letters. The server's full-text search stays a
 * separate group, because it reads page bodies the client does not have.
 * Recent pages live in `localStorage` for this origin only; storage that is
 * blocked or full just means no recents, never an error.
 */
import type { PageRow, SearchResult } from "./api";
import { pageIdHref, searchHref } from "./route";
import { plainSnippet } from "./search";

/** Score for a query word found at the very start of the text. */
const START_SCORE = 120;
/** Score for a query word found at the start of a later word. */
const WORD_START_SCORE = 80;
/** Score for a query word found inside a word. */
const INSIDE_SCORE = 50;
/** Score for a query word whose letters appear in order but apart. */
const SUBSEQUENCE_SCORE = 15;
/** A summary hit counts for this share of a title hit. */
const SUMMARY_WEIGHT = 0.4;
/** A shorter title wins a tie: the query covers more of it. */
const LENGTH_PENALTY = 0.05;

const PAGE_RESULT_LIMIT = 8;
export const RECENT_LIMIT = 6;
const RECENT_KEY = "llmwiki.v2.recentPages";
const DESTINATION_LIMIT = 4;
const TEXT_RESULT_LIMIT = 5;

/** How well one query word matches `text`, or 0 for no match; `loose` allows a close subsequence. */
export function wordScore(word: string, text: string, loose = false): number {
  const haystack = text.toLowerCase();
  const index = haystack.indexOf(word);
  if (index === 0) return START_SCORE;
  if (index > 0) return /[\p{L}\p{N}]/u.test(haystack[index - 1]) ? INSIDE_SCORE : WORD_START_SCORE;
  return loose && isWordwiseSubsequence(word, haystack) ? SUBSEQUENCE_SCORE : 0;
}

/** Whether `index` starts a word in `text`. */
function startsWord(text: string, index: number): boolean {
  return index === 0 || !/[\p{L}\p{N}]/u.test(text[index - 1]);
}

/** The next index of `character` from `from` that starts a word, or -1. */
function nextWordStart(text: string, character: string, from: number): number {
  for (let index = text.indexOf(character, from); index >= 0; index = text.indexOf(character, index + 1)) {
    if (startsWord(text, index)) return index;
  }
  return -1;
}

/** Whether `needle` matches `haystack` letter by letter, each letter continuing the last match or starting a word. */
function isWordwiseSubsequence(needle: string, haystack: string): boolean {
  let next = 0;
  for (const character of needle) {
    const index = next > 0 && haystack[next] === character ? next : nextWordStart(haystack, character, next);
    if (index < 0) return false;
    next = index + 1;
  }
  return true;
}

/** A page's score for `query`, or 0 when some word matches neither its title nor its summary. */
export function pageScore(query: string, row: Pick<PageRow, "title" | "summary">): number {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  let total = 0;
  for (const word of words) {
    const best = Math.max(wordScore(word, row.title, true), wordScore(word, row.summary) * SUMMARY_WEIGHT);
    if (best === 0) return 0;
    total += best;
  }
  return total - row.title.length * LENGTH_PENALTY;
}

/** The best-matching pages for `query`, highest score first. */
export function rankPages(query: string, rows: PageRow[], limit = PAGE_RESULT_LIMIT): PageRow[] {
  return rows
    .map((row) => ({ row, score: pageScore(query, row) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.row.title.localeCompare(b.row.title))
    .slice(0, limit)
    .map((entry) => entry.row);
}

/** The groups the palette shows, in this order. */
export type PaletteGroup = "Recent" | "Pages" | "Go to" | "In page text" | "Search";

/** One row of the palette; `destination` is set on "Go to" rows so the view can draw its icon. */
export interface PaletteItem<D> {
  key: string;
  group: PaletteGroup;
  href: string;
  label: string;
  detail: string;
  destination?: D;
}

/** What the palette lists from. */
export interface PaletteSources<D extends { href: string; label: string }> {
  rows: PageRow[];
  recentIds: string[];
  destinations: D[];
  textResults: SearchResult[];
}

/** A page as a palette row. */
function pageItem<D>(row: PageRow, group: PaletteGroup): PaletteItem<D> {
  return { key: `${group}:${row.id}`, group, href: pageIdHref(row.id), label: row.title || row.id, detail: row.summary };
}

/** A destination as a palette row. */
function destinationItem<D extends { href: string; label: string }>(destination: D): PaletteItem<D> {
  return { key: `go:${destination.href}`, group: "Go to", href: destination.href, label: destination.label, detail: "", destination };
}

/** With no query: recent pages, then every destination. */
function idleItems<D extends { href: string; label: string }>({ rows, recentIds, destinations }: PaletteSources<D>): PaletteItem<D>[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const recent = recentIds.flatMap((id) => (byId.has(id) ? [pageItem<D>(byId.get(id)!, "Recent")] : []));
  return [...recent, ...destinations.map(destinationItem)];
}

/** Everything the palette lists for `query`, grouped and in display order. */
export function paletteItems<D extends { href: string; label: string }>(query: string, sources: PaletteSources<D>): PaletteItem<D>[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return idleItems(sources);
  const pages = rankPages(trimmed, sources.rows).map((row) => pageItem<D>(row, "Pages"));
  const shown = new Set(pages.map((item) => item.href));
  const destinations = sources.destinations
    .filter((destination) => pageScore(trimmed, { title: destination.label, summary: "" }) > 0)
    .slice(0, DESTINATION_LIMIT)
    .map(destinationItem);
  const text = sources.textResults
    .filter((result) => !shown.has(pageIdHref(result.id)))
    .slice(0, TEXT_RESULT_LIMIT)
    .map((result): PaletteItem<D> => ({ key: `text:${result.id}`, group: "In page text", href: pageIdHref(result.id), label: result.title || result.id, detail: plainSnippet(result.snippet) }));
  const search: PaletteItem<D> = { key: "search", group: "Search", href: searchHref(trimmed), label: `Search page text for “${trimmed}”`, detail: "" };
  return [...pages, ...destinations, ...text, search];
}

/** The storage the recents use; a parameter so tests can pass their own. */
type RecentStore = Pick<Storage, "getItem" | "setItem">;

/** The recently opened page ids, newest first; empty when storage is unavailable or holds junk. */
export function readRecent(store: RecentStore | undefined = safeLocalStorage()): string[] {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string").slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

/** Put `id` at the front of the recents. */
export function rememberPage(id: string, store: RecentStore | undefined = safeLocalStorage()): void {
  try {
    store?.setItem(RECENT_KEY, JSON.stringify([id, ...readRecent(store).filter((seen) => seen !== id)].slice(0, RECENT_LIMIT)));
  } catch {
    // Blocked or full storage only costs the recents list.
  }
}

/** `localStorage`, or undefined where reading it throws (private modes, sandboxed frames). */
function safeLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
