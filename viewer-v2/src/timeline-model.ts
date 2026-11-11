/**
 * The timeline screen's shape: the generated day and week pages, grouped into
 * ISO weeks, newest first. Compile writes them to `wiki/timeline/` as
 * `YYYY-MM-DD` (a day) and `YYYY-Www` (a week); anything else in that directory
 * is ignored here. Pure, so it is tested without a browser.
 */
import type { PageRow } from "./api";

/** The directory compile writes timeline pages to. */
export const TIMELINE_DIRECTORY = "timeline";

const DAY_SLUG = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_SLUG = /^\d{4}-W\d{2}$/;
const DAY_MS = 86_400_000;

/** One ISO week: its summary page when compiled, and its day pages, newest first. */
export interface TimelineWeek {
  week: string;
  page: PageRow | null;
  days: PageRow[];
}

/** The ISO-8601 week id (`YYYY-Www`) of a `YYYY-MM-DD` day; weeks start on Monday. */
export function isoWeek(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const thursday = new Date(date.getTime() + (3 - ((date.getUTCDay() + 6) % 7)) * DAY_MS);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.floor((thursday.getTime() - yearStart) / DAY_MS / 7) + 1;
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The timeline pages grouped by week, newest week and newest day first. */
export function timelineWeeks(pages: PageRow[]): TimelineWeek[] {
  const weeks = new Map<string, TimelineWeek>();
  const weekOf = (week: string): TimelineWeek => {
    const entry = weeks.get(week) ?? { week, page: null, days: [] };
    weeks.set(week, entry);
    return entry;
  };
  for (const page of pages) {
    if (page.pageDirectory !== TIMELINE_DIRECTORY) continue;
    if (WEEK_SLUG.test(page.slug)) weekOf(page.slug).page = page;
    else if (DAY_SLUG.test(page.slug)) weekOf(isoWeek(page.slug)).days.push(page);
  }
  for (const entry of weeks.values()) entry.days.sort((a, b) => b.slug.localeCompare(a.slug));
  return [...weeks.values()].sort((a, b) => b.week.localeCompare(a.week));
}
