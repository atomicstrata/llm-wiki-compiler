/**
 * @file src/compiler/source-excerpt.ts
 * @description What every page written from cited source lines shares (timeline
 * days, entity records): the line-range type, the numbered excerpt of source
 * lines a prompt shows (each line with its ORIGINAL number, so the model's
 * `^[file.md:START-END]` citations point at the real lines), the answer format
 * (a `SUMMARY:` line, then cited bullets), and the check for citations of lines
 * the model was not shown.
 */

import { extractClaimCitations } from "../utils/markdown.js";

/** An inclusive, 1-based range of source lines. */
export interface LineRange {
  start: number;
  end: number;
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
 * Any set of source line ranges as a numbered excerpt within the budget, shared
 * fairly as {@link dayExcerpt} describes; `shown` narrows each source's ranges to
 * the rows actually shown. Person pages use it for the lines that mention them.
 */
export function sourcesExcerpt<T extends { file: string; ranges: LineRange[] }>(sources: T[], texts: Map<string, string>): { text: string; shown: T[] } {
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

/**
 * How many of a page's cited spans fall outside the lines it was written from:
 * a file not among the days' sources, or lines past the days' ranges. The model
 * is shown only those lines, so any such span is a citation it made up.
 */
export function citationsOutside(body: string, days: { sources: { file: string; ranges: LineRange[] }[] }[]): number {
  const rangesByFile = new Map<string, LineRange[]>();
  for (const day of days) for (const source of day.sources) {
    rangesByFile.set(source.file, [...(rangesByFile.get(source.file) ?? []), ...source.ranges]);
  }
  const spans = extractClaimCitations(body).flatMap((citation) => citation.spans);
  return spans.filter((span) => {
    const ranges = rangesByFile.get(span.file);
    if (!ranges) return true;
    const lines = span.lines;
    return lines !== undefined && !ranges.some((range) => range.start <= lines.start && lines.end <= range.end);
  }).length;
}

/** Whether two inclusive line ranges share a line. */
export function overlaps(a: LineRange, b: LineRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}
