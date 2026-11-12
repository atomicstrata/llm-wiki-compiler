/**
 * @file src/timeline/buckets.ts
 * @description Group every source's dated line ranges into one bucket per day
 * and one per ISO week, each with a signature of exactly what it was built from.
 * Pure: the caller reads the sources; nothing here touches disk.
 *
 * The signature is what makes timeline pages incremental and idempotent: a day
 * page is regenerated only when the set of (source, source hash, line ranges)
 * feeding it changes, and a week page only when one of its days' signatures
 * does. Re-importing an unchanged source, or compiling twice, rewrites nothing.
 * Bumping {@link TIMELINE_PAGE_VERSION} regenerates every page once, for when
 * the prompts or the page layout change.
 */

import { createHash } from "node:crypto";
import { shortDigest } from "../utils/short-digest.js";
import { sourceDayRanges } from "./event-days.js";
import type { LineRange } from "../compiler/source-excerpt.js";

/** Bump to regenerate every timeline page after a prompt or layout change. */
const TIMELINE_PAGE_VERSION = 2;

/** A source as the timeline reads it. */
export interface TimelineSource {
  file: string;
  hash: string;
  text: string;
}

/** One source's share of a day. */
export interface DaySource {
  file: string;
  hash: string;
  ranges: LineRange[];
}

/** Everything that happened on one day, across sources. */
export interface DayBucket {
  /** `YYYY-MM-DD`. */
  day: string;
  /** Sources in filename order. */
  sources: DaySource[];
  signature: string;
}

/** The days of one ISO week that have anything on them. */
export interface WeekBucket {
  /** ISO week id, `YYYY-Www`. */
  week: string;
  /** The week's days, oldest first. */
  days: DayBucket[];
  signature: string;
}

/**
 * Bucket every source's dated lines by day, oldest day first.
 * @param sources - The compiled sources with their text and hash.
 * @param timeZone - IANA zone for timestamps that carry an offset.
 */
export function dayBuckets(sources: TimelineSource[], timeZone: string): DayBucket[] {
  const byDay = new Map<string, DaySource[]>();
  for (const source of [...sources].sort((a, b) => a.file.localeCompare(b.file))) {
    for (const [day, ranges] of sourceDayRanges(source.file, source.text, timeZone)) {
      byDay.set(day, [...(byDay.get(day) ?? []), { file: source.file, hash: source.hash, ranges }]);
    }
  }
  return [...byDay.keys()].sort().map((day) => {
    const daySources = byDay.get(day)!;
    return { day, sources: daySources, signature: signatureOf(["day", day, daySources]) };
  });
}

/** Group day buckets into ISO weeks, oldest week first. */
export function weekBuckets(days: DayBucket[]): WeekBucket[] {
  const byWeek = new Map<string, DayBucket[]>();
  for (const day of days) {
    const week = isoWeek(day.day);
    byWeek.set(week, [...(byWeek.get(week) ?? []), day]);
  }
  return [...byWeek.keys()].sort().map((week) => {
    const weekDays = byWeek.get(week)!;
    return { week, days: weekDays, signature: signatureOf(["week", week, weekDays.map((day) => day.signature)]) };
  });
}

/** The ISO-8601 week id (`YYYY-Www`) a `YYYY-MM-DD` day falls in; weeks start on Monday. */
export function isoWeek(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  // The Thursday of this week decides the week-numbering year.
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.floor((thursday.getTime() - yearStart) / 86_400_000 / 7) + 1;
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The Monday a `YYYY-Www` week starts on, as `YYYY-MM-DD`. */
export function weekStart(week: string): string {
  const [year, number] = week.split("-W").map(Number);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (number - 1) * 7);
  return monday.toISOString().slice(0, 10);
}

/** A stable digest of a page's inputs and the page format version. */
function signatureOf(inputs: unknown): string {
  return shortDigest([TIMELINE_PAGE_VERSION, inputs]);
}
