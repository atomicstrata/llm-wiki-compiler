/**
 * The timeline screen's shape: the generated day and week pages, grouped into
 * ISO weeks, newest first. Compile writes them to `wiki/timeline/` as
 * `YYYY-MM-DD` (a day) and `YYYY-Www` (a week); anything else in that directory
 * is ignored here. Also where a timeline page leads: the previous and next
 * day or week, a day's week, and a week's days. Pure, so it is tested
 * without a browser.
 */
import type { PageRow } from "./api";

/** The directory compile writes timeline pages to. */
export const TIMELINE_DIRECTORY = "timeline";

const DAY_SLUG = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_SLUG = /^\d{4}-W\d{2}$/;
const DAY_MS = 86_400_000;

/** Whether a timeline slug names a day or a week; null for any other file in the directory. */
export function timelinePeriod(slug: string): "day" | "week" | null {
  if (DAY_SLUG.test(slug)) return "day";
  return WEEK_SLUG.test(slug) ? "week" : null;
}

/** The pages compile learned from sources, leaving out the generated day and week pages. */
export function withoutTimeline(pages: PageRow[]): PageRow[] {
  return pages.filter((page) => page.pageDirectory !== TIMELINE_DIRECTORY);
}

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

/** Where a timeline page leads: its neighbours in time, a day's week, and a week's days. */
export interface TimelineLinks {
  previous: PageRow | null;
  next: PageRow | null;
  /** The week page a day belongs to, when compiled. */
  week: PageRow | null;
  /** A week's day pages, oldest first; empty for a day. */
  days: PageRow[];
}

/** The pages a timeline page links to; days step to days and weeks to weeks, oldest to newest. */
export function timelineLinks(pages: PageRow[], slug: string): TimelineLinks {
  const timeline = pages.filter((page) => page.pageDirectory === TIMELINE_DIRECTORY);
  const isWeek = WEEK_SLUG.test(slug);
  const peers = timeline.filter((page) => (isWeek ? WEEK_SLUG : DAY_SLUG).test(page.slug)).sort((a, b) => a.slug.localeCompare(b.slug));
  const index = peers.findIndex((page) => page.slug === slug);
  const days = timeline.filter((page) => DAY_SLUG.test(page.slug));
  return {
    previous: index > 0 ? peers[index - 1] : null,
    next: index !== -1 && index < peers.length - 1 ? peers[index + 1] : null,
    week: isWeek ? null : timeline.find((page) => page.slug === isoWeek(slug)) ?? null,
    days: isWeek ? days.filter((page) => isoWeek(page.slug) === slug).sort((a, b) => a.slug.localeCompare(b.slug)) : [],
  };
}
