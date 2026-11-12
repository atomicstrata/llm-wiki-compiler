/**
 * @file src/compiler/source-excerpt.ts
 * @description What every page written from cited source lines shares (timeline
 * days, entity records): the line-range type, the numbered excerpt of source
 * lines a prompt shows (each line with its ORIGINAL number, so the model's
 * `^[file.md:START-END]` citations point at the real lines), the answer format
 * (a `SUMMARY:` line, then cited bullets), and fitting the model's citations to
 * the lines it was shown.
 */

import { extractClaimCitations, splitCitationMarker } from "../utils/markdown.js";
import type { SourceSpan } from "../utils/types.js";

/** An inclusive, 1-based range of source lines. */
export interface LineRange {
  start: number;
  end: number;
}

/** A source and the line ranges a prompt showed from it. */
export interface ShownLines {
  file: string;
  ranges: LineRange[];
}

/** One completion request for a page written from source lines. */
export interface PageRequest {
  system: string;
  messages: { role: "user"; content: string }[];
}

/** Characters of source text one excerpt may carry; the rest is cut and the cut is stated. */
const EXCERPT_BUDGET = 60_000;
/** The marker the model's first line must start with. */
export const SUMMARY_PREFIX = "SUMMARY:";
/** The prompt lines asking for cited bullets from the numbered lines shown. */
export const CITED_BULLETS = `Then short "## " sections of bullets. End each bullet with its citation, ^[file.md:START-END], using the line numbers shown.
Only what the records say. No title.`;

/** One source's numbered rows, with the line number each row shows. */
interface SourceRows {
  file: string;
  rows: { line: number; text: string }[];
  size: number;
}

/**
 * Source line ranges as a numbered excerpt (each line under its number in the
 * source) within {@link EXCERPT_BUDGET}. The budget is shared fairly: a small
 * source is shown whole and a large one gets what is left, so one long chat
 * cannot crowd out a meeting note. A source over its share is cut at its first
 * row that does not fit and says how many rows were cut. `shown` narrows each
 * source's ranges to the rows actually shown, so citations can be fitted to
 * what the model saw.
 */
export function sourcesExcerpt<T extends ShownLines>(sources: T[], texts: Map<string, string>): { text: string; shown: T[] } {
  const rows = sources.map((source) => sourceRows(source.file, source.ranges, texts.get(source.file) ?? ""));
  const allowances = fairShares(rows.map((source) => source.size), EXCERPT_BUDGET);
  const rendered = rows.map((source, index) => renderSource(source, allowances[index]));
  return {
    text: rendered.map((source) => source.text).join("\n\n"),
    shown: sources.map((source, index) => ({ ...source, ranges: rendered[index].ranges })),
  };
}

/** A source's rows in `ranges`, numbered with a width fit for the whole file. */
function sourceRows(file: string, ranges: LineRange[], text: string): SourceRows {
  const lines = text.split("\n");
  const width = String(lines.length).length;
  const rows = ranges.flatMap((range) => Array.from({ length: range.end - range.start + 1 }, (_, offset) => {
    const line = range.start + offset;
    return { line, text: `${String(line).padStart(width)} | ${lines[line - 1] ?? ""}` };
  }));
  return { file, rows, size: rows.reduce((sum, row) => sum + row.text.length + 1, 0) };
}

/** Split `budget` so the smallest needs are met in full and the rest share what remains equally. */
function fairShares(sizes: number[], budget: number): number[] {
  const shares = new Array<number>(sizes.length).fill(0);
  let remaining = budget;
  const order = sizes.map((size, index) => ({ size, index })).sort((a, b) => a.size - b.size);
  order.forEach(({ size, index }, position) => {
    shares[index] = Math.min(size, Math.floor(remaining / (order.length - position)));
    remaining -= shares[index];
  });
  return shares;
}

/** Render a source's rows within `allowance`, cut at the first row that does not fit; gaps show as `…`. */
function renderSource(source: SourceRows, allowance: number): { text: string; ranges: LineRange[] } {
  const out: string[] = [];
  const ranges: LineRange[] = [];
  let used = 0;
  let shownRows = 0;
  for (const row of source.rows) {
    if (used + row.text.length + 1 > allowance) break;
    const last = ranges.at(-1);
    if (last && last.end === row.line - 1) last.end = row.line;
    else { if (last) out.push("   …"); ranges.push({ start: row.line, end: row.line }); }
    out.push(row.text);
    used += row.text.length + 1;
    shownRows++;
  }
  const cut = source.rows.length - shownRows;
  if (cut > 0) out.push(`(${cut} more line${cut === 1 ? "" : "s"} not shown: over the excerpt budget. Do not cite them.)`);
  return { text: `--- SOURCE: ${source.file} ---\n\n${out.join("\n")}`, ranges };
}

/**
 * Split a model answer into its summary line and its body. A missing summary
 * line leaves the whole answer as the body and an empty summary.
 */
export function splitAnswer(answer: string): { summary: string; body: string } {
  const trimmed = answer.trim();
  if (!trimmed.startsWith(SUMMARY_PREFIX)) return { summary: "", body: trimmed };
  const newline = trimmed.indexOf("\n");
  const firstLine = newline === -1 ? trimmed : trimmed.slice(0, newline);
  return { summary: firstLine.slice(SUMMARY_PREFIX.length).trim(), body: newline === -1 ? "" : trimmed.slice(newline + 1).trim() };
}

/** Sorted, non-overlapping ranges; adjacent ones join. */
export function mergeRanges(ranges: LineRange[]): LineRange[] {
  const merged: LineRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** A page body with its citations fitted to the shown lines, and how many cited spans still fall outside them. */
export interface FittedCitations {
  body: string;
  outside: number;
}

/**
 * Fit a page body's citations to the lines its prompt showed. The model may cite
 * one range across two shown runs (`97-112` when it saw 94–102 and 110–114); the
 * lines between were never shown, so the span is cut to what was:
 * `97-102, 110-112`. A span with no shown line, or in a file not shown, is left
 * as written and counted in `outside`, since it cites lines the model never saw.
 * Fitting a fitted body changes nothing.
 */
export function fitCitations(body: string, shown: ShownLines[]): FittedCitations {
  const rangesByFile = new Map<string, LineRange[]>();
  for (const source of shown) rangesByFile.set(source.file, mergeRanges([...(rangesByFile.get(source.file) ?? []), ...source.ranges]));
  let outside = 0;
  const fitted = body.replace(CITATION_MARKER, (marker) => {
    if (hasMalformedEntry(marker)) return marker;
    const fits = (extractClaimCitations(marker)[0]?.spans ?? []).map((span) => fitSpan(span, rangesByFile.get(span.file)));
    outside += fits.filter((fit) => fit.outside).length;
    return fits.some((fit) => fit.changed) ? `^[${formatSpans(fits.flatMap((fit) => fit.spans))}]` : marker;
  });
  return { body: fitted, outside };
}

/** A citation marker, `^[…]`. */
const CITATION_MARKER = /\^\[[^\]]+\]/g;

/** Whether a marker has an entry the citation parser drops (`a.md:12-5`); such a marker is left for the linter to report. */
function hasMalformedEntry(marker: string): boolean {
  return splitCitationMarker(marker.slice(2, -1)).some((entry) => entry.trim() && (extractClaimCitations(`^[${entry}]`)[0]?.spans.length ?? 0) === 0);
}

/** One cited span after fitting: the spans it becomes, whether it changed, and whether it cites no shown line. */
interface FittedSpan {
  spans: SourceSpan[];
  changed: boolean;
  outside: boolean;
}

/** A cited span cut to the shown `ranges` of its file. */
function fitSpan(span: SourceSpan, ranges: LineRange[] | undefined): FittedSpan {
  const asWritten = { spans: [span], changed: false };
  if (!ranges) return { ...asWritten, outside: true };
  const lines = span.lines;
  if (!lines || ranges.some((range) => range.start <= lines.start && lines.end <= range.end)) return { ...asWritten, outside: false };
  const cut = ranges.filter((range) => overlaps(range, lines))
    .map((range) => ({ start: Math.max(range.start, lines.start), end: Math.min(range.end, lines.end) }));
  if (cut.length === 0) return { ...asWritten, outside: true };
  return { spans: cut.map((part) => ({ file: span.file, lines: part })), changed: true, outside: false };
}

/** Spans as a citation marker's interior: consecutive spans of one file share it (`a.md:1-2, 5-6, b.md:3-3`). */
function formatSpans(spans: SourceSpan[]): string {
  const entries: { file: string; ranges: string[] }[] = [];
  for (const span of spans) {
    const last = entries.at(-1);
    const range = span.lines ? `${span.lines.start}-${span.lines.end}` : undefined;
    if (last && last.file === span.file && range && last.ranges.length > 0) last.ranges.push(range);
    else entries.push({ file: span.file, ranges: range ? [range] : [] });
  }
  return entries.map((entry) => (entry.ranges.length > 0 ? `${entry.file}:${entry.ranges.join(", ")}` : entry.file)).join(", ");
}

/** Whether two inclusive line ranges share a line. */
export function overlaps(a: LineRange, b: LineRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}
