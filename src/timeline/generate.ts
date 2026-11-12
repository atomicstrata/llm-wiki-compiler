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

import pLimit, { type LimitFunction } from "p-limit";
import type { CompilePageWrite } from "../compiler/compile-write.js";
import type { TimelineSchema } from "../schema/types.js";
import { splitAnswer, type PageRequest, type ShownLines } from "../compiler/source-excerpt.js";
import {
  claimable, completePage, createdAtOf, deleteAndReport, fitAndReportCitations, fitPageCitations, ownPages, pageBody, readSources, stringField, writeAndReport,
  type DerivedResult, type DerivedSteps, type OwnPage, type PageReport,
} from "../compiler/derived-steps.js";
import { dayBuckets, weekBuckets, type DayBucket, type WeekBucket } from "./buckets.js";
import { dailyRequest, weeklyRequest } from "./prompts.js";
import { isTimelinePage, pagesCitingDay, peopleInDay, timelinePage, TIMELINE_NAMESPACE, withDaySections, type CitingPage, type DaySections, type PersonMentions } from "./pages.js";

/** The reads, model call and write a timeline pass composes. */
export interface TimelineSteps extends DerivedSteps {
  /** The concept pages, for each day's "Pages from this day" section. */
  listConceptPages(): Promise<CitingPage[]>;
  /** The people with the lines they are mentioned on, for each day's "People this day" section. */
  listPeople(): Promise<PersonMentions[]>;
  /** One model completion. */
  complete(request: PageRequest): Promise<string>;
}

/** How a timeline pass runs: the project's timeline settings and how many model calls may run at once. */
export interface TimelineRun extends TimelineSchema {
  concurrency: number;
}

/** What one pass works over: its steps, the pages it wrote before, its concurrency, and where it reports. */
interface TimelinePass {
  steps: TimelineSteps;
  existing: Map<string, OwnPage>;
  limit: LimitFunction;
  report: PageReport;
}

/** A day or week page to write, with the body the weekly pass reads (a refreshed tail carries none). */
interface PeriodWrite {
  write: CompilePageWrite;
  body?: string;
}

/** What a regenerated period page is built from, besides the model's answer. */
interface PeriodPage {
  kind: "daily" | "weekly";
  period: string;
  sources: string[];
  signature: string;
  /** The source lines the model was shown, which its citations are fitted to. */
  shown: ShownLines[];
}

/** Bring `wiki/timeline/` up to date with the sources; a disabled timeline does nothing. */
export async function generateTimelineWith(steps: TimelineSteps, run: TimelineRun): Promise<DerivedResult> {
  const report = timelineReport();
  if (!run.enabled) return report.result;
  const read = await readSources(steps);
  const texts = new Map(read.map((source) => [source.file, source.text]));
  const allDays = dayBuckets(read, run.timeZone);
  const { own: existing, foreign } = ownPages(await steps.listPages(TIMELINE_NAMESPACE), isTimelinePage);
  const pass: TimelinePass = { steps, existing, limit: pLimit(run.concurrency), report };
  const days = allDays.filter((day) => claimable(report, day.day, foreign));
  const weeks = weekBuckets(allDays).filter((week) => claimable(report, week.week, foreign) && hasNoForeignDay(report, week, foreign));
  const dailyBodies = await writeDays(pass, days, texts);
  await writeWeeks(pass, weeks, dailyBodies);
  await deleteAndReport(report, steps, orphanDeletes(pass, days, weeks));
  return report.result;
}

/** How the timeline names its pages in what it reports. */
function timelineReport(): PageReport {
  return {
    directory: TIMELINE_NAMESPACE, writer: "the timeline",
    label: (slug) => `Timeline page "${slug}"`, id: (slug) => slug,
    result: { written: [], deleted: [], errors: [] },
  };
}

/** The signature stored on a timeline page: the inputs it was built from. */
function storedSignature(page: OwnPage | undefined): string {
  return page ? stringField(page.meta, "timelineSignature") : "";
}

/** Whether every day of a week can have a generated page; a hand-written day holds the week back, and says so. */
function hasNoForeignDay(report: PageReport, week: WeekBucket, foreign: ReadonlySet<string>): boolean {
  if (week.days.every((day) => !foreign.has(day.day))) return true;
  report.result.errors.push(`Timeline week "${week.week}" not written: one of its days is a hand-written page`);
  return false;
}

/**
 * Write every day whose inputs changed, and refresh the generated tail ("Pages
 * from this day", "People this day") of every other day whose concept or person
 * pages moved, without a model call.
 * @returns Day → page body of the days written, for the weekly pass.
 */
async function writeDays(pass: TimelinePass, days: DayBucket[], texts: Map<string, string>): Promise<Map<string, string>> {
  if (days.length === 0) return new Map();
  const [conceptPages, people] = await Promise.all([pass.steps.listConceptPages(), pass.steps.listPeople()]);
  const singleDayFiles = singleDaySources(days);
  const planned = await Promise.all(days.map((day) => pass.limit(() => planDay(pass, day, texts, {
    related: pagesCitingDay(day, conceptPages, singleDayFiles), people: peopleInDay(day, people),
  }))));
  return commit(pass, planned);
}

/** A day's write: its page regenerated when its lines changed, else its citations and tail refreshed, else nothing. */
async function planDay(pass: TimelinePass, day: DayBucket, texts: Map<string, string>, sections: DaySections): Promise<PeriodWrite | null> {
  const page = pass.existing.get(day.day);
  const { request, shown } = dailyRequest(day, texts);
  if (page && storedSignature(page) === day.signature) {
    const updated = withDaySections(fitPageCitations(page.text, shown), sections);
    return updated === page.text ? null : { write: timelineWrite(day.day, updated) };
  }
  const answer = await completePage(pass.report, (req) => pass.steps.complete(req), request, day.day);
  if (answer === null) return null;
  const sources = day.sources.map((source) => source.file);
  return periodWrite(pass, { kind: "daily", period: day.day, sources, signature: day.signature, shown }, answer, sections);
}

/** Write every week whose days changed and whose days all have pages, and fit the citations of the others. */
async function writeWeeks(pass: TimelinePass, weeks: WeekBucket[], freshDays: Map<string, string>): Promise<void> {
  await commit(pass, await Promise.all(weeks.map((week) => pass.limit(() => planWeek(pass, week, freshDays)))));
}

/**
 * A week's write: its page regenerated when its days changed (null when one of
 * them has no current page or the model call fails), else its citations fitted
 * to its days' lines, else nothing.
 */
async function planWeek(pass: TimelinePass, week: WeekBucket, freshDays: Map<string, string>): Promise<PeriodWrite | null> {
  const page = pass.existing.get(week.week);
  if (page && storedSignature(page) === week.signature) {
    const fitted = fitPageCitations(page.text, week.days.flatMap((day) => day.sources));
    return fitted === page.text ? null : { write: timelineWrite(week.week, fitted) };
  }
  const bodies = week.days.map((day) => ({ day: day.day, body: freshDays.get(day.day) ?? currentBody(pass, day) }));
  if (bodies.some((entry) => !entry.body)) return null;
  const answer = await completePage(pass.report, (req) => pass.steps.complete(req), weeklyRequest(week.week, bodies), week.week);
  if (answer === null) return null;
  const sources = [...new Set(week.days.flatMap((day) => day.sources.map((source) => source.file)))].sort();
  const shown = week.days.flatMap((day) => day.sources);
  return periodWrite(pass, { kind: "weekly", period: week.week, sources, signature: week.signature, shown }, answer);
}

/** The deletes for timeline pages of days and weeks no source covers any more. */
function orphanDeletes(pass: TimelinePass, days: DayBucket[], weeks: WeekBucket[]): CompilePageWrite[] {
  const live = new Set([...days.map((day) => day.day), ...weeks.map((week) => week.week)]);
  return [...pass.existing].filter(([slug]) => !live.has(slug))
    .map(([slug, page]) => ({ ...timelineWrite(slug, page.text), deleting: true }));
}

/** A regenerated day or week page from the model's answer, keeping the page's original creation time. */
function periodWrite(pass: TimelinePass, page: PeriodPage, answer: string, sections?: DaySections): PeriodWrite {
  const { summary, body } = splitAnswer(fitAndReportCitations(pass.report, page.period, answer, page.shown));
  const now = pass.steps.now();
  const text = timelinePage({
    kind: page.kind, period: page.period, sources: page.sources, signature: page.signature, summary,
    createdAt: createdAtOf(pass.existing.get(page.period), now), updatedAt: now, provenance: pass.steps.provenance(),
  }, body, sections);
  return { write: timelineWrite(page.period, text), body };
}

/** A write of `text` to `wiki/timeline/<slug>.md`. */
function timelineWrite(slug: string, text: string): CompilePageWrite {
  return { namespace: TIMELINE_NAMESPACE, slug, body: text };
}

/** Apply the planned writes; returns slug → body of the regenerated pages that landed, for the weekly pass. */
async function commit(pass: TimelinePass, planned: (PeriodWrite | null)[]): Promise<Map<string, string>> {
  const ready = planned.filter((plan): plan is PeriodWrite => plan !== null);
  const landed = new Set(await writeAndReport(pass.report, pass.steps, ready.map((plan) => plan.write)));
  return new Map(ready.filter((plan) => plan.body && landed.has(plan.write)).map((plan) => [plan.write.slug, plan.body!]));
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
function currentBody(pass: TimelinePass, day: DayBucket): string {
  const page = pass.existing.get(day.day);
  if (!page || storedSignature(page) !== day.signature) return "";
  return pageBody(page.text);
}
