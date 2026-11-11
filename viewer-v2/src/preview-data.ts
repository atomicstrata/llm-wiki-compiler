/**
 * Data behind the hover previews: what a wikilink or citation chip points at,
 * and the text to show for it. Everything here except the cached loaders at
 * the end is pure, so it is tested without a browser.
 */
import { fetchPage, fetchSourceText, type PageRow } from "./api";
import { closestElement } from "./dom";
import { htmlText } from "./page-model";
import { lineRange } from "./route";
import { humanLabel } from "./wiki-model";

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
  return humanLabel(row?.entityType ?? row?.pageDirectory ?? id.split("/")[0]);
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
  const lastSpace = text.lastIndexOf(" ", maxChars);
  return `${text.slice(0, lastSpace > 0 ? lastSpace : maxChars)}…`;
}

/**
 * Texts fetched for previews, kept for one wiki snapshot. The source route
 * serves whole files with `no-store` and the page route re-renders on every
 * call, so hovering the same chip twice should not fetch twice; but after a
 * compile the live shell holds a new snapshot, and stale texts are dropped.
 */
const previewTexts = { snapshot: "", texts: new Map<string, Promise<string>>() };

/** The text under `key` for `snapshot`, loaded once; a failure is forgotten so a later hover can retry. */
function cached(snapshot: string, key: string, load: () => Promise<string>): Promise<string> {
  if (previewTexts.snapshot !== snapshot) previewTexts.texts = new Map();
  previewTexts.snapshot = snapshot;
  const hit = previewTexts.texts.get(key);
  if (hit) return hit;
  const pending = load().catch((error: unknown) => {
    previewTexts.texts.delete(key);
    throw error;
  });
  previewTexts.texts.set(key, pending);
  return pending;
}

/** A page card's text: the row's summary when it has one, else the page's opening paragraph. */
export function pageBlurb(id: string, row: PageRow | undefined, snapshot: string): Promise<string> {
  if (row?.summary) return Promise.resolve(row.summary);
  const slash = id.indexOf("/");
  return cached(snapshot, `page:${id}`, async () => plainOpening((await fetchPage(id.slice(0, slash), id.slice(slash + 1))).html));
}

/** The text a citation card excerpts; a citation whose file is missing has none to fetch. */
export function citedSourceText(target: CitationTarget, snapshot: string): Promise<string> {
  if (!target.resolved) return Promise.reject(new Error(`Source not found: ${target.file}`));
  return cached(snapshot, `source:${target.file}`, () => fetchSourceText(target.file));
}
