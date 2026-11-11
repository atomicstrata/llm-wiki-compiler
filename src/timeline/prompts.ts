/**
 * @file src/timeline/prompts.ts
 * @description What the model is shown and asked for when writing a daily or a
 * weekly timeline page.
 *
 * A daily page is written from that day's source lines only, each shown with its
 * ORIGINAL line number, so the model's `^[file.md:START-END]` citations point at
 * the real lines exactly as concept pages' citations do. A weekly page is written
 * from the week's daily pages and keeps their citations, so every weekly claim
 * still resolves to source lines.
 *
 * Both answers start with a `SUMMARY:` line that becomes the page's summary.
 */

import type { DayBucket } from "./buckets.js";
import { CITED_BULLETS, SUMMARY_PREFIX, sourcesExcerpt, type PageRequest } from "../compiler/source-excerpt.js";


const DAILY_SYSTEM = `Summarize what happened on this day, from the records below, for a personal memory, in the third person.
First line: "${SUMMARY_PREFIX} " and one sentence.
${CITED_BULLETS}`;

const WEEKLY_SYSTEM = `Summarize this week, from its daily pages below, for a personal memory, in the third person.
First line: "${SUMMARY_PREFIX} " and one sentence.
Then short "## " sections by theme, not by day. End each bullet with the citations it draws on, copied exactly from the daily pages.
No title.`;

/** A day request, and the day narrowed to the lines the request actually shows. */
export interface DailyRequest {
  request: PageRequest;
  shown: DayBucket;
}

/**
 * The request for a day page.
 * @param bucket - The day and the line ranges that fall on it.
 * @param texts - Source filename → full text, for every source in the bucket.
 */
export function dailyRequest(bucket: DayBucket, texts: Map<string, string>): DailyRequest {
  const excerpt = dayExcerpt(bucket, texts);
  const content = `Records for ${bucket.day}:\n\n${excerpt.text}\n\nWrite the page for ${bucket.day}.`;
  return { request: { system: DAILY_SYSTEM, messages: [{ role: "user", content }] }, shown: excerpt.shown };
}

/**
 * The request for a week page.
 * @param week - The ISO week id.
 * @param dailyBodies - Each day of the week with its page body, oldest first.
 */
export function weeklyRequest(week: string, dailyBodies: { day: string; body: string }[]): PageRequest {
  const pages = dailyBodies.map(({ day, body }) => `--- DAY: ${day} ---\n\n${body.trim()}`).join("\n\n");
  return {
    system: WEEKLY_SYSTEM,
    messages: [{ role: "user", content: `Daily pages for ${week}:\n\n${pages}\n\nWrite the page for ${week}.` }],
  };
}

/**
 * The day's lines from every source, numbered as in the source, within
 * {@link DAY_EXCERPT_BUDGET}. The budget is shared fairly: a small source is
 * shown whole and a large one gets what is left, so one long chat cannot crowd
 * out a meeting note on the same day. A source over its share is cut at its
 * first row that does not fit and says how many rows were cut. `shown` is the
 * day narrowed to the rows actually shown, so citations can be checked against
 * what the model saw.
 */
export function dayExcerpt(bucket: DayBucket, texts: Map<string, string>): { text: string; shown: DayBucket } {
  const { text, shown } = sourcesExcerpt(bucket.sources, texts);
  return { text, shown: { ...bucket, sources: shown } };
}
