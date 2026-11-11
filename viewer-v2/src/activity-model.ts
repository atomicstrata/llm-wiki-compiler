/**
 * The numbers behind the live dashboard, free of React and the DOM: pages
 * changed since the reader's last visit, a calendar of compile activity, and
 * the tag counts the topic map draws.
 *
 * "Last visit" survives reloads: a visit is stamped only when the previous
 * stamp is more than half an hour old, so refreshing the page or coming back
 * from lunch does not reset what counts as new, while the next day's visit
 * does. Stamps live in `localStorage` for this origin; storage that is
 * blocked just means the dashboard has no "since last visit" to show.
 */
import type { PageRow } from "./api";

/** A gap longer than this between stamps starts a new visit. */
const NEW_VISIT_GAP_MS = 30 * 60 * 1000;
const VISIT_KEY = "llmwiki.v2.visits";
const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS_PER_WEEK = 7;
export const ACTIVITY_WEEKS = 16;
const HEAT_LEVELS = 4;

/** Two stamps: when the visit before this one started, and when this one did. */
interface VisitStamps {
  previous: string | null;
  current: string;
}

type VisitStore = Pick<Storage, "getItem" | "setItem">;

/** Read the stamps, tolerating junk. */
function readStamps(store: VisitStore): VisitStamps | null {
  try {
    const parsed = JSON.parse(store.getItem(VISIT_KEY) ?? "null") as Partial<VisitStamps> | null;
    return typeof parsed?.current === "string" ? { previous: typeof parsed.previous === "string" ? parsed.previous : null, current: parsed.current } : null;
  } catch {
    return null;
  }
}

/** Record this visit and return when the previous one started, or null on a first visit. */
export function stampVisit(store: VisitStore | undefined, now: Date): string | null {
  if (store === undefined) return null;
  const stamps = readStamps(store);
  const isNewVisit = stamps === null || now.getTime() - Date.parse(stamps.current) > NEW_VISIT_GAP_MS;
  const next: VisitStamps = isNewVisit ? { previous: stamps?.current ?? null, current: now.toISOString() } : stamps;
  try {
    store.setItem(VISIT_KEY, JSON.stringify(next));
  } catch {
    // Blocked storage only costs the "since last visit" panel.
  }
  return next.previous;
}

/** Pages updated after `since`, newest first. */
export function changedSince(pages: PageRow[], since: string): PageRow[] {
  const cutoff = Date.parse(since);
  return pages
    .filter((page) => Date.parse(page.updatedAt) > cutoff)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** One calendar day of activity. */
export interface ActivityDay {
  date: string;
  count: number;
}

/** A date's local `YYYY-MM-DD`. */
function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Pages updated per day for `weeks` whole weeks ending with the week of `now`, Sunday first, oldest day first. */
export function dailyActivity(pages: PageRow[], now: Date, weeks = ACTIVITY_WEEKS): ActivityDay[] {
  const counts = new Map<string, number>();
  for (const page of pages) {
    const updated = new Date(page.updatedAt);
    if (!Number.isNaN(updated.getTime())) counts.set(localDay(updated), (counts.get(localDay(updated)) ?? 0) + 1);
  }
  const lastSunday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
  const start = lastSunday.getTime() - (weeks - 1) * DAYS_PER_WEEK * DAY_MS;
  return Array.from({ length: weeks * DAYS_PER_WEEK }, (_, index) => {
    const day = new Date(start + index * DAY_MS + DAY_MS / 2);
    return { date: localDay(day), count: counts.get(localDay(day)) ?? 0 };
  });
}

/** A count's shade from 0 (none) to 4 (the busiest day). */
export function heatLevel(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  return Math.max(1, Math.ceil((count / max) * HEAT_LEVELS));
}

/** One tag and how many pages carry it. */
export interface TagCount {
  tag: string;
  count: number;
}

/** The most used tags, most pages first, then alphabetically. */
export function tagCounts(pages: PageRow[], limit: number): TagCount[] {
  const counts = new Map<string, number>();
  for (const page of pages) for (const tag of new Set(page.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, limit);
}

/** A tag's size step from 0 to 3, by its share of the most used tag. */
export function tagWeight(count: number, max: number): number {
  return max <= 0 ? 0 : Math.min(3, Math.floor((count / max) * 4));
}
