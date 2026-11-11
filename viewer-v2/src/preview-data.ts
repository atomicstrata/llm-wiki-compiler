/**
 * Data behind the hover previews: what a wikilink or citation chip points at,
 * and the text to show for it. Page openings and source files are fetched at
 * most once per session and kept in memory, because the source route serves
 * whole files with `no-store` and the page route re-renders on every call; a
 * reader hovering the same chip twice should not pay for it twice. Everything
 * here except the two loaders is pure so it can be tested without a browser.
 */
import { fetchPage, fetchSourceText, type PageRow } from "./api";
import { closestElement } from "./dom";
import { htmlText } from "./page-model";
import { lineRange } from "./route";
import { typeLabel } from "./wiki-model";

/** A span of a source file; no lines means the citation names the whole file. */
export interface CitationTarget {
  kind: "citation";
  file: string;
  lineStart?: number;
  lineEnd?: number;
  resolved: boolean;
}

/** What a hovered element previews: a wiki page by id, or a span of a source file. */
export type PreviewTarget = { kind: "page"; id: string } | CitationTarget;

/** One numbered line of a cited excerpt. */
export interface ExcerptLine {
  number: number;
  text: string;
}

/** The cited lines to show, and how many more the span covers beyond them. */
export interface Excerpt {
  lines: ExcerptLine[];
  hiddenCount: number;
}

/** A long span is cut here; the card is a glance, the source view is the full read. */
export const MAX_EXCERPT_LINES = 8;
/** A whole-file citation shows this many opening lines. */
const WHOLE_FILE_LINES = 8;
const OPENING_MAX_CHARS = 280;

const TRIGGER_SELECTOR = "a[data-page-id], .citation-chip[data-file]";

/** The nearest preview trigger at or above `node`, if any. */
export function findTrigger(node: EventTarget | null): HTMLElement | null {
  return closestElement(node, TRIGGER_SELECTOR);
}

/** Whether `trigger` is the open or about-to-open one, so moving within it changes nothing. */
export function isTracked(trigger: HTMLElement | null, ...tracked: (HTMLElement | null)[]): boolean {
  return trigger !== null && tracked.includes(trigger);
}

/** The small label above a page card's title: its profile type or directory. */
export function pageKindLabel(id: string, row: PageRow | undefined): string {
  return typeLabel(row?.entityType ?? row?.pageDirectory ?? id.split("/")[0]);
}

/** Read what a trigger element previews; a citation's lines follow the same rules as a source link's. */
export function previewTarget(trigger: HTMLElement): PreviewTarget | null {
  const { pageId, file, lineStart, lineEnd, resolved } = trigger.dataset;
  if (pageId) return { kind: "page", id: pageId };
  if (!file) return null;
  return { kind: "citation", file, ...lineRange(lineStart, lineEnd), resolved: resolved !== "false" };
}

/** The cited lines of `text`, numbered from 1; a citation without lines shows the file's opening. */
export function sliceExcerpt(text: string, lineStart?: number, lineEnd?: number): Excerpt {
  const all = text.split(/\r?\n/);
  const first = lineStart ?? 1;
  const last = Math.min(lineStart === undefined ? WHOLE_FILE_LINES : (lineEnd ?? first), all.length);
  const shownLast = Math.min(last, first + MAX_EXCERPT_LINES - 1);
  const lines = all.slice(first - 1, shownLast).map((line, index) => ({ number: first + index, text: line }));
  return { lines, hiddenCount: Math.max(0, last - shownLast) };
}

/** The first paragraph of rendered page HTML as plain text, cut at a word near `maxChars`. */
export function plainOpening(html: string, maxChars = OPENING_MAX_CHARS): string {
  const paragraph = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(html)?.[1] ?? "";
  const text = htmlText(paragraph.replace(/<span[^>]*class="citation-chip"[^>]*>[\s\S]*?<\/span>/g, "")).replace(/\s+/g, " ");
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : maxChars)}…`;
}

const sourceTexts = new Map<string, Promise<string>>();
const pageOpenings = new Map<string, Promise<string>>();

/** Memoize a loader by key, forgetting a failure so a later hover can retry. */
function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = load().catch((error: unknown) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, pending);
  return pending;
}

/** A source file's full text, fetched once. */
function loadSourceText(file: string): Promise<string> {
  return cached(sourceTexts, file, () => fetchSourceText(file));
}

/** A page card's text: the row's summary when it has one, else the page's fetched opening. */
export function pageBlurb(id: string, row: PageRow | undefined): Promise<string> {
  return row?.summary ? Promise.resolve(row.summary) : loadPageOpening(id);
}

/** The text a citation card excerpts; a citation whose file is missing has none to fetch. */
export function citedSourceText(target: CitationTarget): Promise<string> {
  return target.resolved ? loadSourceText(target.file) : Promise.reject(new Error(`Source not found: ${target.file}`));
}

/** A page's opening paragraph, fetched once; used when its row has no summary. */
function loadPageOpening(id: string): Promise<string> {
  const slash = id.indexOf("/");
  return cached(pageOpenings, id, async () => plainOpening((await fetchPage(id.slice(0, slash), id.slice(slash + 1))).html));
}
