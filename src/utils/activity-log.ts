/**
 * Append-only activity log (log.md).
 *
 * Implements the chronological journal described in Karpathy's llm-wiki gist:
 * a single append-only file recording what happened and when — ingests,
 * compiles, queries, and lint passes. Each entry is a heading line with a
 * fixed prefix — `## [YYYY-MM-DDThh:mm:ssZ] operation | description` —
 * optionally followed by a markdown bullet body carrying detail (page
 * wikilinks, counts).
 *
 * The heading prefix is what keeps the log parseable: because only headings
 * start with `## [`, the gist's recipe `grep "^## \[" log.md | tail -5` still
 * returns the five most recent operations even though entries now have bodies.
 * The log complements wiki/index.md: the index organizes content for
 * discovery, the log tracks temporal progression.
 */

import { appendFile } from "fs/promises";
import path from "path";
import {
  LOG_FILE,
  LOG_DESCRIPTION_MAX_CHARS,
  LOG_MAX_PAGE_LINKS,
} from "./constants.js";
import * as output from "./output.js";

/** Unicode ellipsis appended when a description is truncated. */
const TRUNCATION_MARKER = "…";

/** Optional extras for a log entry. */
export interface LogEntryOptions {
  /** Markdown bullet detail lines rendered under the heading (page links, counts). */
  details?: string[];
  /** Entry timestamp; rendered as ISO 8601 UTC to second precision. Defaults to now. */
  date?: Date;
}

/**
 * Collapse whitespace (including newlines) and cap length so the heading stays
 * a single, grep-friendly line regardless of what the caller passes in.
 */
function sanitizeDescription(description: string): string {
  const singleLine = description.replace(/\s+/g, " ").trim();
  if (singleLine.length <= LOG_DESCRIPTION_MAX_CHARS) return singleLine;
  return singleLine.slice(0, LOG_DESCRIPTION_MAX_CHARS - 1) + TRUNCATION_MARKER;
}

/**
 * Render items as a comma-separated string, truncating past `cap` with a
 * "(+N more)" suffix. Returns an empty string for an empty list so callers can
 * skip the detail line entirely.
 *
 * @param items - Pre-rendered list items (filenames, wikilinks, …).
 * @param cap - Max items to show before truncating; defaults to the configured limit.
 */
export function formatList(items: string[], cap: number = LOG_MAX_PAGE_LINKS): string {
  const shown = items.slice(0, cap);
  const remaining = items.length - shown.length;
  const suffix = remaining > 0 ? `, … (+${remaining} more)` : "";
  return shown.join(", ") + suffix;
}

/**
 * Render a list of page slugs as a comma-separated wikilink string, truncating
 * past {@link LOG_MAX_PAGE_LINKS}. Returns an empty string for an empty list.
 *
 * @param slugs - Page slugs to render as `[[slug]]` wikilinks.
 * @param cap - Max links to show before truncating; defaults to the configured limit.
 */
export function formatWikilinkList(
  slugs: string[],
  cap: number = LOG_MAX_PAGE_LINKS,
): string {
  return formatList(slugs.map((slug) => `[[${slug}]]`), cap);
}

/**
 * Format one log entry: the parseable `## [YYYY-MM-DDThh:mm:ssZ] operation |
 * description` heading, plus a `- detail` bullet for each provided detail line.
 * Pure and date-injectable so it can be unit-tested deterministically.
 *
 * @param operation - Short operation tag, e.g. "ingest", "compile", "query".
 * @param description - Human-readable heading detail (title, counts, question).
 * @param date - The entry's timestamp; rendered as ISO 8601 UTC to second precision.
 * @param details - Optional bullet lines rendered under the heading.
 */
export function formatLogEntry(
  operation: string,
  description: string,
  date: Date,
  details: string[] = [],
): string {
  // ISO 8601 UTC to second precision, e.g. 2026-06-05T14:58:41Z. Sorts
  // lexicographically and still matches the gist's `^## \[` grep recipe.
  const timestamp = date.toISOString().slice(0, 19) + "Z";
  const heading = `## [${timestamp}] ${operation} | ${sanitizeDescription(description)}`;
  if (details.length === 0) return heading;
  const body = details.map((line) => `- ${line}`).join("\n");
  return `${heading}\n${body}`;
}

/**
 * Append a single entry to the project's log.md, blank-line separated from the
 * previous one.
 *
 * Resilient by design: the log is a side journal, so a write failure warns but
 * never throws — recording an event must not break the operation it records.
 *
 * @param root - Absolute path to the project root directory.
 * @param operation - Short operation tag, e.g. "ingest", "compile", "query".
 * @param description - Human-readable heading detail for the entry.
 * @param opts - Optional bullet body and entry date.
 */
export async function appendLog(
  root: string,
  operation: string,
  description: string,
  opts: LogEntryOptions = {},
): Promise<void> {
  try {
    const entry = formatLogEntry(operation, description, opts.date ?? new Date(), opts.details);
    await appendFile(path.join(root, LOG_FILE), `${entry}\n\n`, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.status("!", output.warn(`Skipped log.md update: ${message}`));
  }
}
