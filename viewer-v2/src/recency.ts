/**
 * Recency buckets and short ages for timestamps, in the reader's local time.
 *
 * Buckets follow the calendar rather than rolling windows, the convention
 * document tools use: Today, Yesterday, Earlier this week, Last week,
 * Earlier this month, then one bucket per older month, and Undated last.
 * Weeks start on Monday. Everything takes `now` as an argument so a test can
 * freeze the clock. Day arithmetic goes through the `Date` constructor, never
 * by adding 24 hours: a day around a daylight-saving change is 23 or 25 hours
 * long, and millisecond maths would put yesterday's pages in last week.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const DAYS_PER_WEEK = 7;
export const UNDATED = "Undated";

const MONTH_LABEL = new Intl.DateTimeFormat("en", { month: "long", year: "numeric" });

/** Local midnight of the day `moment` falls on. */
function startOfDay(moment: Date): Date {
  return new Date(moment.getFullYear(), moment.getMonth(), moment.getDate());
}

/** Local midnight `days` calendar days after `moment`'s day; negative goes back. */
export function addDays(moment: Date, days: number): Date {
  return new Date(moment.getFullYear(), moment.getMonth(), moment.getDate() + days);
}

/** Local midnight of the Monday that starts `moment`'s week. */
function startOfWeek(moment: Date): Date {
  return addDays(moment, -((moment.getDay() + DAYS_PER_WEEK - 1) % DAYS_PER_WEEK));
}

/** The timestamp as a Date, or null when missing or unparseable. */
function parseTimestamp(iso: string): Date | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The bucket label a timestamp falls in, relative to `now`. */
export function recencyBucket(iso: string, now: Date): string {
  const then = parseTimestamp(iso);
  if (then === null) return UNDATED;
  const today = startOfDay(now);
  const day = startOfDay(then);
  if (day >= today) return "Today";
  if (day.getTime() === addDays(today, -1).getTime()) return "Yesterday";
  const thisWeek = startOfWeek(now);
  if (day >= thisWeek) return "Earlier this week";
  if (day >= addDays(thisWeek, -DAYS_PER_WEEK)) return "Last week";
  if (then.getFullYear() === now.getFullYear() && then.getMonth() === now.getMonth()) return "Earlier this month";
  return MONTH_LABEL.format(then);
}

/** A short elapsed time such as "moments", "20 min", "3 h" or "2 d"; empty when undated. */
export function relativeAge(iso: string, now: Date): string {
  const then = parseTimestamp(iso);
  if (then === null) return "";
  const elapsed = Math.max(0, now.getTime() - then.getTime());
  if (elapsed < MINUTE_MS) return "moments";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} h`;
  return `${Math.floor(elapsed / DAY_MS)} d`;
}

/** One recency group: its label and its items, newest first. */
export interface RecencyGroup<T> {
  label: string;
  items: T[];
}

/** A timestamp's sort key: its instant, or minus infinity when undated so it sorts last. */
function sortKey(iso: string): number {
  return parseTimestamp(iso)?.getTime() ?? Number.NEGATIVE_INFINITY;
}

/**
 * Sort items newest first and split them into buckets, in the order the
 * buckets first appear; items without a timestamp sort last, under Undated.
 * Sorting compares instants, not strings, so `+02:00` and `Z` timestamps
 * interleave correctly.
 */
export function groupByRecency<T>(items: T[], timestampOf: (item: T) => string, now: Date): RecencyGroup<T>[] {
  const sorted = [...items].sort((a, b) => sortKey(timestampOf(b)) - sortKey(timestampOf(a)));
  const groups: RecencyGroup<T>[] = [];
  for (const item of sorted) {
    const label = recencyBucket(timestampOf(item), now);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}
