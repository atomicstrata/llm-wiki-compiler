/**
 * @file src/timeline/prompts.ts
 * @description What the model is shown and asked for when writing a daily or a
 * weekly timeline page.
 *
 * A daily page is written from that day's source lines only, each shown with its
 * ORIGINAL line number, so the model's `^[file.md:START-END]` citations point at
 * the real lines exactly as concept pages' citations do. A weekly page is written
 * from the week's daily pages and keeps their citations, so every weekly claim
 * still resolves to source lines.
 *
 * Both answers start with a `SUMMARY:` line that becomes the page's summary.
 */

import type { DayBucket } from "./buckets.js";
import type { LineRange } from "./event-days.js";

/** Characters of source text one daily prompt may carry; the rest is cut and the cut is stated. */
const DAY_EXCERPT_BUDGET = 60_000;
/** The marker the model's first line must start with. */
const SUMMARY_PREFIX = "SUMMARY:";

const DAILY_SYSTEM = `Summarize what happened on this day, from the records below, for a personal memory, in the third person.
First line: "${SUMMARY_PREFIX} " and one sentence.
Then short "## " sections of bullets. End each bullet with its citation, ^[file.md:START-END], using the line numbers shown.
Only what the records say. No title.`;

const WEEKLY_SYSTEM = `Summarize this week, from its daily pages below, for a personal memory, in the third person.
First line: "${SUMMARY_PREFIX} " and one sentence.
Then short "## " sections by theme, not by day. End each bullet with the citations it draws on, copied exactly from the daily pages.
No title.`;

/** One completion request for a timeline page. */
export interface TimelineRequest {
  system: string;
  messages: { role: "user"; content: string }[];
}

/** A day request, and the day narrowed to the lines the request actually shows. */
export interface DailyRequest {
  request: TimelineRequest;
  shown: DayBucket;
}

/**
 * The request for a day page.
 * @param bucket - The day and the line ranges that fall on it.
 * @param texts - Source filename → full text, for every source in the bucket.
 */
export function dailyRequest(bucket: DayBucket, texts: Map<string, string>): DailyRequest {
  const excerpt = dayExcerpt(bucket, texts);
  const content = `Records for ${bucket.day}:\n\n${excerpt.text}\n\nWrite the page for ${bucket.day}.`;
  return { request: { system: DAILY_SYSTEM, messages: [{ role: "user", content }] }, shown: excerpt.shown };
}

/**
 * The request for a week page.
 * @param week - The ISO week id.
 * @param dailyBodies - Each day of the week with its page body, oldest first.
 */
export function weeklyRequest(week: string, dailyBodies: { day: string; body: string }[]): TimelineRequest {
  const pages = dailyBodies.map(({ day, body }) => `--- DAY: ${day} ---\n\n${body.trim()}`).join("\n\n");
  return {
    system: WEEKLY_SYSTEM,
    messages: [{ role: "user", content: `Daily pages for ${week}:\n\n${pages}\n\nWrite the page for ${week}.` }],
  };
}

/** One source's numbered rows for the day, with the line number each row shows. */
interface SourceRows {
  file: string;
  rows: { line: number; text: string }[];
  size: number;
}

/**
 * The day's lines from every source, numbered as in the source, within
 * {@link DAY_EXCERPT_BUDGET}. The budget is shared fairly: a small source is
 * shown whole and a large one gets what is left, so one long chat cannot crowd
 * out a meeting note on the same day. A source over its share is cut at its
 * first row that does not fit and says how many rows were cut. `shown` is the
 * day narrowed to the rows actually shown, so citations can be checked against
 * what the model saw.
 */
export function dayExcerpt(bucket: DayBucket, texts: Map<string, string>): { text: string; shown: DayBucket } {
  const { text, shown } = sourcesExcerpt(bucket.sources, texts);
  return { text, shown: { ...bucket, sources: shown } };
}

/**
 * Any set of source line ranges as a numbered excerpt within the budget, shared
 * fairly as {@link dayExcerpt} describes; `shown` narrows each source's ranges to
 * the rows actually shown. Person pages use it for the lines that mention them.
 */
export function sourcesExcerpt<T extends { file: string; ranges: LineRange[] }>(sources: T[], texts: Map<string, string>): { text: string; shown: T[] } {
  const rows = sources.map((source) => sourceRows(source.file, source.ranges, texts.get(source.file) ?? ""));
  const allowances = fairShares(rows.map((source) => source.size), DAY_EXCERPT_BUDGET);
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
