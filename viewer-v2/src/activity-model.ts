/**
 * The numbers behind the live dashboard, free of React and the DOM: pages
 * changed since the reader's last visit, a calendar of compile activity, and
 * the tag counts the topic map draws.
 *
 * A visit ends after half an hour without activity. The shell marks activity
 * on every screen change, so a reader who keeps reading stays in one visit,
 * reloads change nothing, and what counts as new is everything since they
 * were last active before this visit began. Stamps live in `localStorage` for
 * this origin (see `storage.ts`).
 */
import type { PageRow } from "./api";
import { addDays } from "./recency";
import { readStored, writeStored, type KeyValueStore } from "./storage";

/** This long without activity ends a visit. */
const NEW_VISIT_GAP_MS = 30 * 60 * 1000;
const VISIT_KEY = "llmwiki.v2.visits";
const DAYS_PER_WEEK = 7;
export const ACTIVITY_WEEKS = 16;
const HEAT_LEVELS = 4;

/** When the current visit's "since" point is, and when the reader was last active. */
interface VisitStamps {
  since: string | null;
  lastSeen: string;
}

/** The stored stamps, or null for a first visit or anything unreadable. */
function readStamps(store: KeyValueStore | undefined): VisitStamps | null {
  const stored = readStored(store, VISIT_KEY) as Partial<VisitStamps> | null;
  if (typeof stored?.lastSeen !== "string") return null;
  return { since: typeof stored.since === "string" ? stored.since : null, lastSeen: stored.lastSeen };
}

/**
 * Note that the reader is active now, and return what counts as new for this
 * visit: the moment they were last active before it began, or null on a first
 * visit or without storage.
 */
export function stampVisit(store: KeyValueStore | undefined, now: Date): string | null {
  if (store === undefined) return null;
  const stamps = readStamps(store);
  const isNewVisit = stamps === null || now.getTime() - Date.parse(stamps.lastSeen) > NEW_VISIT_GAP_MS;
  const since = isNewVisit ? (stamps?.lastSeen ?? null) : stamps.since;
  writeStored(store, VISIT_KEY, { since, lastSeen: now.toISOString() });
  return since;
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
  const first = addDays(now, -now.getDay() - (weeks - 1) * DAYS_PER_WEEK);
  return Array.from({ length: weeks * DAYS_PER_WEEK }, (_, index) => {
    const day = localDay(addDays(first, index));
    return { date: day, count: counts.get(day) ?? 0 };
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
