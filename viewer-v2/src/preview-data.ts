/**
 * Data behind the hover previews: what a wikilink or citation chip points at,
 * and the text to show for it. Page openings and source files are fetched at
 * most once per session and kept in memory, because the source route serves
 * whole files with `no-store` and the page route re-renders on every call; a
 * reader hovering the same chip twice should not pay for it twice. Everything
 * here except the two loaders is pure so it can be tested without a browser.
 */
import { fetchPage, fetchSourceText, type PageRow } from "./api";
import { typeLabel } from "./wiki-model";

/** What a hovered element previews: a wiki page by id, or a span of a source file. */
export type PreviewTarget =
  | { kind: "page"; id: string }
  | { kind: "citation"; file: string; lineStart: number | null; lineEnd: number | null; resolved: boolean };

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

/** A positive line number from a data attribute, or null. */
function lineNumber(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** The nearest preview trigger at or above `node`, if any; text nodes and the window have no `closest`. */
export function findTrigger(node: EventTarget | null): HTMLElement | null {
  const element = node as Partial<Element> | null;
  return typeof element?.closest === "function" ? element.closest<HTMLElement>(TRIGGER_SELECTOR) : null;
}

/** Whether `trigger` is the open or about-to-open one, so moving within it changes nothing. */
export function isTracked(trigger: HTMLElement | null, ...tracked: (HTMLElement | null)[]): boolean {
  return trigger !== null && tracked.includes(trigger);
}

/** The small label above a page card's title: its profile type or directory. */
export function pageKindLabel(id: string, row: PageRow | undefined): string {
  return typeLabel(row?.entityType ?? row?.pageDirectory ?? id.split("/")[0]);
}

/** Read what a trigger element previews. */
export function previewTarget(trigger: HTMLElement): PreviewTarget | null {
  const { pageId, file, lineStart, lineEnd, resolved } = trigger.dataset;
  if (pageId) return { kind: "page", id: pageId };
  if (!file) return null;
  const start = lineNumber(lineStart);
  return { kind: "citation", file, lineStart: start, lineEnd: lineNumber(lineEnd) ?? start, resolved: resolved !== "false" };
}

/** The cited lines of `text`, numbered from 1; a citation without lines shows the file's opening. */
export function sliceExcerpt(text: string, lineStart: number | null, lineEnd: number | null): Excerpt {
  const all = text.split(/\r?\n/);
  const first = lineStart ?? 1;
  const last = Math.min(lineEnd ?? (lineStart === null ? WHOLE_FILE_LINES : first), all.length);
  const shownLast = Math.min(last, first + MAX_EXCERPT_LINES - 1);
  const lines = all.slice(first - 1, shownLast).map((line, index) => ({ number: first + index, text: line }));
  return { lines, hiddenCount: Math.max(0, last - shownLast) };
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'", "&nbsp;": " " };

/** The first paragraph of rendered page HTML as plain text, cut at a word near `maxChars`. */
export function plainOpening(html: string, maxChars = OPENING_MAX_CHARS): string {
  const paragraph = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(html)?.[1] ?? "";
  const text = paragraph
    .replace(/<span[^>]*class="citation-chip"[^>]*>[\s\S]*?<\/span>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&[#\w]+;/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\s+/g, " ")
    .trim();
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
export function citedSourceText(target: Extract<PreviewTarget, { kind: "citation" }>): Promise<string> {
  return target.resolved ? loadSourceText(target.file) : Promise.reject(new Error(`Source not found: ${target.file}`));
}

/** A page's opening paragraph, fetched once; used when its row has no summary. */
function loadPageOpening(id: string): Promise<string> {
  const slash = id.indexOf("/");
  return cached(pageOpenings, id, async () => plainOpening((await fetchPage(id.slice(0, slash), id.slice(slash + 1))).html));
}
