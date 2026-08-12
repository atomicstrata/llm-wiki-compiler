/**
 * @file src/export/timestamps.ts
 * @description Rendering a page's two instants in the TEXT export formats.
 *
 * `ExportPage.createdAt`/`updatedAt` are OPTIONAL. A page that declares no
 * timestamp — every `query --save` page declares no `updatedAt`, and a
 * hand-authored page may declare neither — carries no key at all, because the
 * export refuses to substitute its own run clock for an instant the page never
 * recorded (see `readPageTimestamps` in `collect.ts`).
 *
 * That leaves every text writer with the same question — what to print when
 * there is nothing to print — and the same answer: nothing. A rendered
 * `created:  | updated:` is not an absent date, it is a malformed one, and it
 * reads as a rendering fault rather than as data the page never had. Shared here
 * so llms.txt and Marp cannot drift apart on it.
 *
 * The structured formats do not use this: JSON-LD and GraphML omit a KEY rather
 * than a labelled clause, and OKF already guarded its one timestamp field.
 */

import type { ExportPage } from "./types.js";

/**
 * The `<label>: <instant>` clauses a page can state, created first.
 *
 * Empty when the page declares neither, so a caller joining these into a
 * metadata line drops the whole segment instead of emitting a labelled blank.
 * The labels are parameters because the formats disagree on casing — llms.txt
 * bullets use `created`, its full-text headers use `Created` — and that is a
 * presentation choice, not a reason for a second copy of this logic.
 *
 * @param page - The page being rendered.
 * @param createdLabel - Label for the creation instant.
 * @param updatedLabel - Label for the last-updated instant.
 * @returns Zero, one, or two clauses, in reading order.
 */
export function timestampClauses(
  page: ExportPage,
  createdLabel: string,
  updatedLabel: string,
): string[] {
  const clauses: string[] = [];
  if (page.createdAt) clauses.push(`${createdLabel}: ${page.createdAt}`);
  if (page.updatedAt) clauses.push(`${updatedLabel}: ${page.updatedAt}`);
  return clauses;
}
