/**
 * @file src/timeline/pages.ts
 * @description Assemble timeline pages: titles, frontmatter and the
 * deterministic "Pages from this day" section that ties a day (the episode) to
 * the concept pages built from its lines (what was learned).
 *
 * Frontmatter carries `timeline` (`daily` | `weekly`), the `date` or `week` it
 * covers, its `sources`, and `timelineSignature`, which the generator compares
 * on the next compile to skip a page whose inputs have not changed.
 */

import { buildFrontmatter, extractClaimCitations } from "../utils/markdown.js";
import type { LineRange } from "./event-days.js";
import type { DayBucket } from "./buckets.js";
import { weekStart } from "./buckets.js";

/** The wiki namespace timeline pages live in: `wiki/timeline/`. */
export const TIMELINE_NAMESPACE = "timeline";
/** The generated section linking a day to the concept pages built from it. */
const RELATED_HEADING = "## Pages from this day";
/**
 * Where the generated section starts. An HTML comment renders as nothing, and
 * unlike the heading it cannot appear in what the model writes, so the section
 * is found by its LAST marker and the model's text above it is never cut.
 */
const RELATED_MARKER = "<!-- llmwiki:timeline-related -->";

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

/** `Monday, May 4, 2026` for a day. */
function dayTitle(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC", weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
}

/** `Week of May 4, 2026` for an ISO week. */
function weekTitle(week: string): string {
  const monday = new Date(`${weekStart(week)}T00:00:00Z`);
  return `Week of ${monday.toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" })}`;
}

/** The full markdown of a timeline page. */
export function timelinePage(meta: TimelinePageMeta, body: string, related: CitingPage[] = []): string {
  const frontmatter = buildFrontmatter({
    title: meta.kind === "daily" ? dayTitle(meta.period) : weekTitle(meta.period),
    summary: meta.summary,
    sources: meta.sources,
    timeline: meta.kind,
    [meta.kind === "daily" ? "date" : "week"]: meta.period,
    timelineSignature: meta.signature,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ...meta.provenance,
  });
  return `${frontmatter}\n\n${body.trim()}${relatedSection(related)}\n`;
}

/** The "Pages from this day" section, or nothing when no page cites the day. */
function relatedSection(related: CitingPage[]): string {
  return related.length === 0 ? "" : `\n\n${RELATED_MARKER}\n${RELATED_HEADING}\n\n${related.map((page) => `- [[${page.slug}|${page.title}]]`).join("\n")}`;
}

/**
 * A page's text with its "Pages from this day" section replaced by `related`.
 * The section is derived from concept pages, which change without the day's
 * sources changing, so it is kept current on every compile without a model call.
 */
export function withRelated(text: string, related: CitingPage[]): string {
  return `${withoutRelated(text).trimEnd()}${relatedSection(related)}\n`;
}

/** Text with the generated section, from its last marker to the end, removed. */
export function withoutRelated(text: string): string {
  const marker = text.lastIndexOf(RELATED_MARKER);
  return marker === -1 ? text : text.slice(0, marker);
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

/**
 * How many of a page's cited spans fall outside the lines it was written from:
 * a file not among the days' sources, or lines past the days' ranges. The model
 * is shown only those lines, so any such span is a citation it made up.
 */
export function citationsOutside(body: string, days: DayBucket[]): number {
  const rangesByFile = new Map<string, LineRange[]>();
  for (const day of days) for (const source of day.sources) {
    rangesByFile.set(source.file, [...(rangesByFile.get(source.file) ?? []), ...source.ranges]);
  }
  const spans = extractClaimCitations(body).flatMap((citation) => citation.spans);
  return spans.filter((span) => {
    const ranges = rangesByFile.get(span.file);
    if (!ranges) return true;
    const lines = span.lines;
    return lines !== undefined && !ranges.some((range) => range.start <= lines.start && lines.end <= range.end);
  }).length;
}

/** Whether two inclusive line ranges share a line. */
function overlaps(a: LineRange, b: LineRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}
