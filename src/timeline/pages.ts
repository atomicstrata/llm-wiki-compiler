/**
 * @file src/timeline/pages.ts
 * @description Assemble timeline pages: titles, frontmatter and the
 * deterministic tail that ties a day (the episode) to the concept pages built
 * from its lines (what was learned) and to the people in it.
 *
 * Frontmatter carries `timeline` (`daily` | `weekly`), the `date` or `week` it
 * covers, its `sources`, and `timelineSignature`, which the generator compares
 * on the next compile to skip a page whose inputs have not changed.
 */

import { buildFrontmatter, extractClaimCitations } from "../utils/markdown.js";
import { overlaps, type LineRange } from "../compiler/source-excerpt.js";
import { linkList, withGenerated, type PageLink } from "../wiki/generated-section.js";
import type { DayBucket } from "./buckets.js";
import { weekStart } from "./buckets.js";

/** The wiki namespace timeline pages live in: `wiki/timeline/`. */
export const TIMELINE_NAMESPACE = "timeline";
/** A concept page, as the related-pages section needs it. */
export interface CitingPage {
  slug: string;
  title: string;
  body: string;
}

/** What a timeline page records about itself in frontmatter. */
export interface TimelinePageMeta {
  kind: "daily" | "weekly";
  /** `YYYY-MM-DD` for a day, `YYYY-Www` for a week. */
  period: string;
  summary: string;
  sources: string[];
  signature: string;
  createdAt: string;
  updatedAt: string;
  /** Model provenance, stamped by the caller. */
  provenance: Record<string, unknown>;
}

/** `May 4, 2026` for a `YYYY-MM-DD` day, or `Monday, May 4, 2026` with its weekday. */
export function formatDay(day: string, withWeekday: boolean): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC", ...(withWeekday ? { weekday: "long" } : {}), year: "numeric", month: "long", day: "numeric",
  });
}

/** `Week of May 4, 2026` for an ISO week. */
function weekTitle(week: string): string {
  return `Week of ${formatDay(weekStart(week), false)}`;
}

/** A day's generated tail: the concept pages built from its lines, and the people in it. */
export interface DaySections {
  related: CitingPage[];
  people: PageLink[];
}

/** The full markdown of a timeline page. */
export function timelinePage(meta: TimelinePageMeta, body: string, sections: DaySections = { related: [], people: [] }): string {
  const frontmatter = buildFrontmatter({
    title: meta.kind === "daily" ? formatDay(meta.period, true) : weekTitle(meta.period),
    summary: meta.summary,
    sources: meta.sources,
    timeline: meta.kind,
    [meta.kind === "daily" ? "date" : "week"]: meta.period,
    timelineSignature: meta.signature,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ...meta.provenance,
  });
  return withGenerated(`${frontmatter}\n\n${body.trim()}\n`, daySections(sections));
}

/** A person (a link to their page) with the source lines they are mentioned on, as the timeline reads them. */
export interface PersonMentions extends PageLink {
  spans: { file: string; lines: LineRange }[];
}

/** The people mentioned on any of a day's lines, by title. */
export function peopleInDay(bucket: DayBucket, people: PersonMentions[]): PageLink[] {
  const rangesByFile = new Map(bucket.sources.map((source) => [source.file, source.ranges]));
  return people
    .filter((person) => person.spans.some((span) => rangesByFile.get(span.file)?.some((range) => overlaps(range, span.lines))))
    .map(({ target, title }) => ({ target, title }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** A day's generated tail as markdown: the concept pages built from its lines, then the people in it. */
function daySections({ related, people }: DaySections): string {
  const pages = related.map((page) => ({ target: page.slug, title: page.title }));
  return [
    pages.length > 0 ? `## Pages from this day\n\n${linkList(pages)}` : "",
    people.length > 0 ? `## People this day\n\n${linkList(people)}` : "",
  ].filter(Boolean).join("\n\n");
}

/**
 * A day page's text with its generated tail rebuilt. The tail is derived from
 * concept and person pages, which change without the day's sources changing,
 * so it is kept current on every compile without a model call.
 */
export function withDaySections(text: string, sections: DaySections): string {
  return withGenerated(text, daySections(sections));
}

/**
 * The concept pages citing any of the day's lines, by title. A citation of a
 * whole file counts only when that file's content is all on this one day.
 */
export function pagesCitingDay(bucket: DayBucket, pages: CitingPage[], singleDayFiles: ReadonlySet<string>): CitingPage[] {
  const rangesByFile = new Map(bucket.sources.map((source) => [source.file, source.ranges]));
  return pages
    .filter((page) => extractClaimCitations(page.body).some((citation) => citation.spans.some((span) => {
      const ranges = rangesByFile.get(span.file);
      if (!ranges) return false;
      return span.lines ? ranges.some((range) => overlaps(range, span.lines!)) : singleDayFiles.has(span.file);
    })))
    .sort((a, b) => a.title.localeCompare(b.title));
}
