/**
 * @file src/timeline/generate.ts
 * @description Compile's timeline step: write a page for every day the sources
 * cover and one for every ISO week, regenerating only pages whose inputs
 * changed, and removing pages for periods no source covers any more.
 *
 * Order: read the compiled sources → bucket by day and week → write the stale
 * daily pages (from the day's source lines) → write the stale weekly pages (from
 * their daily pages) → delete orphaned periods. Daily pages are written before
 * weekly ones because a week reads its days.
 *
 * Each page is rebuilt from its inputs, never appended to, so a re-run is
 * idempotent and an edited source rewrites exactly the days it touches. A day
 * whose model call fails is skipped and reported; its week waits until every
 * day has a page, so a week is never built from a partial set and then marked
 * current by its signature.
 *
 * ONE BODY over {@link TimelineSteps}, like compile's other steps: the model call
 * is the host's, the reads and the compile page write are domain steps.
 */

import pLimit from "p-limit";
import { parseFrontmatter } from "../utils/markdown.js";
import type { CompilePageWrite } from "../compiler/compile-write.js";
import { dayBuckets, weekBuckets, type DayBucket, type WeekBucket } from "./buckets.js";
import { dailyRequest, splitAnswer, weeklyRequest, type TimelineRequest } from "./prompts.js";
import { citationsOutside, pagesCitingDay, peopleInDay, timelinePage, TIMELINE_NAMESPACE, withDaySections, type CitingPage, type DayPerson, type PersonMentions } from "./pages.js";
import { withoutGenerated } from "../wiki/generated-section.js";
import { applyWrites, type DerivedSteps } from "../compiler/derived-steps.js";

/** How the timeline is configured for a project. */
export interface TimelineConfig {
  enabled: boolean;
  /** IANA zone that decides which day an offset timestamp falls on. */
  timeZone: string;
}

/** The reads, model call and write a timeline pass composes. */
export interface TimelineSteps extends DerivedSteps {
  /** Slugs of the pages already in `wiki/timeline/`. */
  listTimelineSlugs(): Promise<string[]>;
  /** A timeline page's text, or `""` when absent. */
  readTimelinePage(slug: string): Promise<string>;
  /** The concept pages, for each day's "Pages from this day" section. */
  listConceptPages(): Promise<CitingPage[]>;
  /** The people with the lines they are mentioned on, for each day's "People this day" section. */
  listPeople(): Promise<PersonMentions[]>;
  /** One model completion. */
  complete(request: TimelineRequest): Promise<string>;
}

/** What a timeline pass did. */
export interface TimelineResult {
  written: string[];
  deleted: string[];
  errors: string[];
}

/** The pages already on disk, by slug: their text and the signature they were built from. */
type ExistingPages = Map<string, { text: string; signature: string; createdAt: string }>;

/**
 * Bring `wiki/timeline/` up to date with the sources.
 * @param steps - Reads, model call and write.
 * @param config - The project's timeline settings; a disabled timeline does nothing.
 * @param concurrency - How many model calls may run at once.
 */
export async function generateTimelineWith(steps: TimelineSteps, config: TimelineConfig, concurrency: number): Promise<TimelineResult> {
  const result: TimelineResult = { written: [], deleted: [], errors: [] };
  if (!config.enabled) return result;
  const { days: allDays, texts } = await readDays(steps, config.timeZone);
  const { pages: existing, foreign } = await readExisting(steps);
  const days = allDays.filter((day) => isWritable(day.day, foreign, result));
  const weeks = weekBuckets(allDays).filter((week) => isWritable(week.week, foreign, result) && hasNoForeignDay(week, foreign, result));
  const limit = pLimit(Math.max(1, concurrency));
  const dailyWrites = await writeDays(steps, days, texts, existing, limit, result);
  await writeWeeks(steps, weeks, existing, dailyWrites, limit, result);
  await deleteOrphans(steps, days, weeks, existing, result);
  return result;
}

/** Read every compiled source and bucket its dated lines by day. */
async function readDays(steps: TimelineSteps, timeZone: string): Promise<{ days: DayBucket[]; texts: Map<string, string> }> {
  const sources = await steps.listSources();
  const read = await Promise.all(sources.map(async (source) => ({ ...source, text: await steps.readSource(source.file) })));
  const texts = new Map(read.map((source) => [source.file, source.text]));
  return { days: dayBuckets(read, timeZone), texts };
}

/**
 * The pages this step generated, with the signature each was built from, and the
 * slugs of the other files in `wiki/timeline/`. A file without `timeline`
 * frontmatter was not written here, so it is never replaced or deleted.
 */
async function readExisting(steps: TimelineSteps): Promise<{ pages: ExistingPages; foreign: Set<string> }> {
  const pages: ExistingPages = new Map();
  const foreign = new Set<string>();
  for (const slug of await steps.listTimelineSlugs()) {
    const text = await steps.readTimelinePage(slug);
    if (!text) continue;
    const { meta } = parseFrontmatter(text);
    if (meta.timeline !== "daily" && meta.timeline !== "weekly") { foreign.add(slug); continue; }
    pages.set(slug, {
      text,
      signature: typeof meta.timelineSignature === "string" ? meta.timelineSignature : "",
      createdAt: typeof meta.createdAt === "string" ? meta.createdAt : "",
    });
  }
  return { pages, foreign };
}

/** Whether every day of a week can have a generated page; a hand-written day holds the week back, and says so. */
function hasNoForeignDay(week: WeekBucket, foreign: ReadonlySet<string>, result: TimelineResult): boolean {
  if (week.days.every((day) => !foreign.has(day.day))) return true;
  result.errors.push(`Timeline week "${week.week}" not written: one of its days is a hand-written page`);
  return false;
}

/** Whether a period's page may be written: not when a file this step did not write already holds its name. */
function isWritable(period: string, foreign: ReadonlySet<string>, result: TimelineResult): boolean {
  if (!foreign.has(period)) return true;
  result.errors.push(`wiki/timeline/${period}.md was not written by the timeline; left as it is`);
  return false;
}

/**
 * Write every day whose inputs changed, and refresh the generated tail ("Pages
 * from this day", "People this day") of every other day whose concept or person
 * pages moved, without a model call.
 * @returns Day → page body of the days written, for the weekly pass.
 */
async function writeDays(
  steps: TimelineSteps, days: DayBucket[], texts: Map<string, string>, existing: ExistingPages,
  limit: ReturnType<typeof pLimit>, result: TimelineResult,
): Promise<Map<string, string>> {
  if (days.length === 0) return new Map();
  const [conceptPages, people] = await Promise.all([steps.listConceptPages(), steps.listPeople()]);
  const singleDayFiles = singleDaySources(days);
  const writes = await Promise.all(days.map((day) => limit(async () => {
    const related = pagesCitingDay(day, conceptPages, singleDayFiles);
    const dayPeople = peopleInDay(day, people);
    const page = existing.get(day.day);
    if (page && page.signature === day.signature) return refreshedSections(page.text, day.day, related, dayPeople);
    const { request, shown } = dailyRequest(day, texts);
    const answer = await completeOrRecord(steps, request, day.day, result);
    if (answer === null) return null;
    reportStrayCitations(answer, day.day, [shown], result);
    return pageWrite(steps, existing, { kind: "daily", period: day.day, sources: day.sources.map((s) => s.file), signature: day.signature }, answer, related, dayPeople);
  })));
  return commit(steps, writes, result);
}

/** A rewrite of a current day page whose generated tail is out of date, or null when it is up to date. */
function refreshedSections(text: string, day: string, related: CitingPage[], people: DayPerson[]): (CompilePageWrite & { pageBody: string }) | null {
  const updated = withDaySections(text, related, people);
  if (updated === text) return null;
  return { namespace: TIMELINE_NAMESPACE, slug: day, body: updated, pageBody: "" };
}

/** Write every week whose days changed and whose days all have pages. */
async function writeWeeks(
  steps: TimelineSteps, weeks: WeekBucket[], existing: ExistingPages, freshDays: Map<string, string>,
  limit: ReturnType<typeof pLimit>, result: TimelineResult,
): Promise<void> {
  const stale = weeks.filter((week) => existing.get(week.week)?.signature !== week.signature);
  const writes = await Promise.all(stale.map((week) => limit(async () => {
    const bodies = week.days.map((day) => ({ day: day.day, body: freshDays.get(day.day) ?? currentBody(existing, day) }));
    if (bodies.some((entry) => !entry.body)) return null;
    const answer = await completeOrRecord(steps, weeklyRequest(week.week, bodies), week.week, result);
    if (answer === null) return null;
    reportStrayCitations(answer, week.week, week.days, result);
    const sources = [...new Set(week.days.flatMap((day) => day.sources.map((s) => s.file)))].sort();
    return pageWrite(steps, existing, { kind: "weekly", period: week.week, sources, signature: week.signature }, answer);
  })));
  await commit(steps, writes, result);
}

/** Remove timeline pages for days and weeks no source covers any more. */
async function deleteOrphans(steps: TimelineSteps, days: DayBucket[], weeks: WeekBucket[], existing: ExistingPages, result: TimelineResult): Promise<void> {
  const live = new Set([...days.map((day) => day.day), ...weeks.map((week) => week.week)]);
  const writes = [...existing].filter(([slug]) => !live.has(slug))
    .map(([slug, page]): CompilePageWrite => ({ namespace: TIMELINE_NAMESPACE, slug, body: page.text, deleting: true }));
  const { landed, blocked } = await applyWrites(steps, writes);
  for (const write of blocked) result.errors.push(`Timeline page "${write.slug}" not removed`);
  result.deleted.push(...landed.map((write) => write.slug));
}

/** A day or week page write, keeping the page's original creation time. */
function pageWrite(
  steps: TimelineSteps, existing: ExistingPages,
  page: { kind: "daily" | "weekly"; period: string; sources: string[]; signature: string },
  answer: string, related: CitingPage[] = [], people: DayPerson[] = [],
): CompilePageWrite & { pageBody: string } {
  const { summary, body } = splitAnswer(answer);
  const now = steps.now();
  const createdAt = existing.get(page.period)?.createdAt || now;
  const text = timelinePage({ ...page, summary, createdAt, updatedAt: now, provenance: steps.provenance() }, body, related, people);
  return { namespace: TIMELINE_NAMESPACE, slug: page.period, body: text, pageBody: body };
}

/** Record a page that cites lines it was not written from. The page is still written; the compile output names it. */
function reportStrayCitations(answer: string, period: string, days: DayBucket[], result: TimelineResult): void {
  const stray = citationsOutside(splitAnswer(answer).body, days);
  if (stray > 0) result.errors.push(`Timeline page "${period}" cites ${stray} span${stray === 1 ? "" : "s"} outside the lines it was written from`);
}

/** The model's answer, or null after recording why there is none. */
async function completeOrRecord(steps: TimelineSteps, request: TimelineRequest, period: string, result: TimelineResult): Promise<string | null> {
  try {
    const answer = await steps.complete(request);
    if (splitAnswer(answer).body) return answer;
    result.errors.push(`Timeline page "${period}" came back empty`);
  } catch (error) {
    result.errors.push(`Timeline page "${period}" failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return null;
}

/** Apply the successful writes; returns slug → body of the regenerated pages that landed (a refreshed related section carries none). */
async function commit(steps: TimelineSteps, writes: ((CompilePageWrite & { pageBody: string }) | null)[], result: TimelineResult): Promise<Map<string, string>> {
  const ready = writes.filter((write): write is CompilePageWrite & { pageBody: string } => write !== null);
  const bodies = new Map(ready.map((write) => [write.slug, write.pageBody]));
  const { landed, blocked } = await applyWrites(steps, ready.map(({ pageBody: _body, ...write }) => write));
  for (const write of blocked) result.errors.push(`Timeline page "${write.slug}" skipped by the write floor`);
  result.written.push(...landed.map((write) => write.slug));
  return new Map(landed.flatMap((write): [string, string][] => (bodies.get(write.slug) ? [[write.slug, bodies.get(write.slug)!]] : [])));
}

/** Files whose dated content falls on exactly one day, so a whole-file citation of them belongs to that day. */
function singleDaySources(days: DayBucket[]): Set<string> {
  const dayCount = new Map<string, number>();
  for (const day of days) for (const source of day.sources) dayCount.set(source.file, (dayCount.get(source.file) ?? 0) + 1);
  return new Set([...dayCount].filter(([, count]) => count === 1).map(([file]) => file));
}

/**
 * A day page's body as the week should read it, or `""` when the page on disk was
 * built from other inputs (its regeneration failed this run) and must not be used.
 */
function currentBody(existing: ExistingPages, day: DayBucket): string {
  const page = existing.get(day.day);
  if (!page || page.signature !== day.signature) return "";
  return withoutGenerated(parseFrontmatter(page.text).body).trim();
}
