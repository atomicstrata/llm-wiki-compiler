/**
 * @file src/timeline/event-days.ts
 * @description Which calendar days a source's content happened on, and which of
 * its lines belong to each day. Pure: text in, day → line ranges out.
 *
 * A source dates its content in one of two ways:
 *
 *  - PER LINE. A chat or log export stamps each entry, e.g.
 *    `- 2026-05-04 12:33 Name: text`, in time order. When a source reads as such
 *    a log, every stamped line goes to its own day and an unstamped line
 *    continues the entry above it (a wrapped message). Lines before the first
 *    stamp are the file's header and belong to no day. A source reads as a log
 *    when its stamps span more than one day and either it has no other date, or
 *    it has at least {@link MIN_LOG_ENTRIES} stamps in time order (oldest or
 *    newest first). That
 *    keeps an ordinary dated note listing a few dated items (a plan, an agenda)
 *    in one piece. Stamps inside fenced code blocks are not entries.
 *  - WHOLE FILE. Anything else (a meeting note, a ticket) happened on one day:
 *    frontmatter `date`, else `created_at` / `createdAt`, else a `YYYY-MM-DD`
 *    filename prefix, else the one day its stamped lines name. The whole body
 *    after the frontmatter is that day's range.
 *
 * Only real calendar dates count: `2026-02-30` or `0000-00-00` is ignored, as
 * an unparseable stamp is.
 *
 * A source with no date at all is simply not on the timeline. Line numbers are
 * the file's own 1-based numbers, so a citation built from them is valid against
 * the source exactly as compile's citations are.
 *
 * Time zones: a stamp with an offset (`Z`, `-04:00`, `-0400`) is converted to
 * the configured zone before taking its date; a stamp without one is already
 * wall time and is taken as written.
 */

import type { LineRange } from "../compiler/source-excerpt.js";

/** A line-leading stamp: an optional list marker, a date, a time, and an optional offset. */
const LINE_STAMP = /^\s*(?:[-*]\s+)?(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?(?![\d:])/;
/** A date at the start of a filename, as collectors name dated sources. */
const FILENAME_DATE = /^(\d{4}-\d{2}-\d{2})(?!\d)/;
/** Frontmatter keys that name when a source's content happened, most specific first. */
const DATE_KEYS = ["date", "created_at", "createdAt"] as const;
const FRONTMATTER_FENCE = "---";
/** A fenced code block's opening or closing line. */
const CODE_FENCE = /^\s*(```|~~~)/;
/** The fewest stamped entries that make a dated source read as a log rather than a note. */
const MIN_LOG_ENTRIES = 3;

/**
 * The days a source's content happened on, each with its line ranges.
 * @param file - The source's filename, consulted for a date prefix.
 * @param text - The source's whole text.
 * @param timeZone - IANA zone that offset timestamps are converted into.
 * @returns Day (`YYYY-MM-DD`) → ranges, in ascending line order; empty when undated.
 */
export function sourceDayRanges(file: string, text: string, timeZone: string): Map<string, LineRange[]> {
  const lines = text.split("\n");
  const bodyStart = frontmatterEnd(lines) + 1;
  const body = bodyRange(lines, bodyStart);
  if (!body) return new Map();
  const stamped = stampedLineDays(lines, bodyStart, timeZone);
  const stampedDays = new Set(stamped.values());
  const fileDay = wholeFileDay(file, lines.slice(0, bodyStart - 1), timeZone);
  if (readsAsLog(stamped, fileDay !== null)) return perLineRanges(body.end, stamped);
  const day = fileDay ?? (stampedDays.size === 1 ? [...stampedDays][0] : null);
  return day ? new Map([[day, [body]]]) : new Map();
}

/** Whether stamped lines make the source a multi-day log; see the file header. */
function readsAsLog(stamped: Map<number, string>, hasFileDay: boolean): boolean {
  const days = [...stamped.values()];
  if (new Set(days).size < 2) return false;
  if (!hasFileDay) return true;
  const ascending = days.every((day, index) => index === 0 || days[index - 1] <= day);
  const descending = days.every((day, index) => index === 0 || days[index - 1] >= day);
  return days.length >= MIN_LOG_ENTRIES && (ascending || descending);
}

/** The 1-based line of the closing frontmatter fence, or 0 when the file has no frontmatter. */
function frontmatterEnd(lines: string[]): number {
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) return 0;
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === FRONTMATTER_FENCE);
  return close === -1 ? 0 : close + 1;
}

/** 1-based line → day for every body line outside fenced code that starts with a valid timestamp. */
function stampedLineDays(lines: string[], bodyStart: number, timeZone: string): Map<number, string> {
  const fenced = fencedLines(lines, bodyStart);
  const stamped = new Map<number, string>();
  for (let index = bodyStart - 1; index < lines.length; index++) {
    if (fenced.has(index)) continue;
    const match = LINE_STAMP.exec(lines[index]);
    const day = match ? stampDay(match[1], match[2], match[3], timeZone) : null;
    if (day) stamped.set(index + 1, day);
  }
  return stamped;
}

/** 0-based indexes of lines inside closed code fences; an opener that never closes fences nothing. */
function fencedLines(lines: string[], bodyStart: number): Set<number> {
  const fenced = new Set<number>();
  let open: number | null = null;
  for (let index = bodyStart - 1; index < lines.length; index++) {
    if (!CODE_FENCE.test(lines[index])) continue;
    if (open === null) { open = index; continue; }
    for (let line = open; line <= index; line++) fenced.add(line);
    open = null;
  }
  return fenced;
}

/** The day of a matched stamp: its own date when it has no offset, else the date in `timeZone`. */
function stampDay(date: string, time: string, offset: string | undefined, timeZone: string): string | null {
  if (!isCalendarDate(date)) return null;
  return offset ? zonedDay(`${date}T${time}${normalizeOffset(offset)}`, timeZone) : date;
}

/**
 * Group stamped lines, and the unstamped lines continuing them, into contiguous
 * ranges per day, from the first stamp to `lastLine` (the body's last non-blank line).
 */
function perLineRanges(lastLine: number, stamped: Map<number, string>): Map<string, LineRange[]> {
  const ranges = new Map<string, LineRange[]>();
  const firstStamp = Math.min(...stamped.keys());
  let current = stamped.get(firstStamp)!;
  for (let line = firstStamp; line <= lastLine; line++) {
    current = stamped.get(line) ?? current;
    const dayRanges = ranges.get(current) ?? [];
    const last = dayRanges.at(-1);
    if (last && last.end === line - 1) last.end = line;
    else dayRanges.push({ start: line, end: line });
    ranges.set(current, dayRanges);
  }
  return ranges;
}

/** The single day a whole-file source happened on: frontmatter first, then the filename. */
function wholeFileDay(file: string, frontmatterLines: string[], timeZone: string): string | null {
  for (const key of DATE_KEYS) {
    const value = frontmatterValue(frontmatterLines, key);
    const day = value ? dayOf(value, timeZone) : null;
    if (day) return day;
  }
  const fromName = FILENAME_DATE.exec(file)?.[1];
  return fromName && isCalendarDate(fromName) ? fromName : null;
}

/** A top-level scalar frontmatter value, without a trailing comment or quotes, or null. */
function frontmatterValue(frontmatterLines: string[], key: string): string | null {
  const prefix = `${key}:`;
  const line = frontmatterLines.find((candidate) => candidate.startsWith(prefix));
  const value = line?.slice(prefix.length).replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
  return value ? value : null;
}

/** The day of a date or timestamp string: converted when it carries an offset, else as written. */
function dayOf(value: string, timeZone: string): string | null {
  const date = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?)?$/.exec(value);
  return date ? stampDay(date[1], date[2] ?? "00:00", date[3], timeZone) : null;
}

/** Whether `YYYY-MM-DD` names a real calendar day (so not `2026-02-30` or `0000-00-00`). */
function isCalendarDate(day: string): boolean {
  const [year, month, date] = day.split("-").map(Number);
  // Date.UTC maps years 0-99 onto 1900-1999, so they cannot round-trip; no source is that old.
  if (year < 1000 || month < 1 || month > 12 || date < 1) return false;
  const parsed = new Date(Date.UTC(year, month - 1, date));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === date;
}

/** `-0400` → `-04:00`: the form `Date.parse` accepts. */
function normalizeOffset(offset: string): string {
  return /^[+-]\d{4}$/.test(offset) ? `${offset.slice(0, 3)}:${offset.slice(3)}` : offset;
}

/** The calendar day an absolute instant falls on in `timeZone`, or null when it does not parse. */
function zonedDay(instant: string, timeZone: string): string | null {
  const time = Date.parse(instant);
  if (Number.isNaN(time)) return null;
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(time);
}

/** The body's lines without trailing blank lines, or null when the body is empty. */
function bodyRange(lines: string[], bodyStart: number): LineRange | null {
  let end = lines.length;
  while (end >= bodyStart && lines[end - 1].trim() === "") end--;
  return end >= bodyStart ? { start: bodyStart, end } : null;
}
