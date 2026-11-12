/**
 * @file src/entities/pages.ts
 * @description Assemble the pages compile writes for extracted records: one
 * page per record (the owner page is in owner.ts).
 *
 * A record page's frontmatter is deterministic: the display name, every other
 * name it went by (`aliases`), the type's declared fields agreed from its
 * mentions, the sources it appears in, and `entitySignature`, a hash of
 * everything the model is shown. Its body is written by the model from the lines
 * that mention the record (plus a little context), each claim cited to those
 * lines. Its generated tail lists the timeline days it appears on and the
 * records it might be the same as; that tail is rebuilt on every compile without
 * a model call.
 */

import { frontmatterEnd, type DerivedResult, type PageReport } from "../compiler/derived-steps.js";
import { validateEntityFields } from "../profile/field-contract.js";
import type { EntityTypeDef } from "../profile/types.js";
import { shortDigest } from "../utils/short-digest.js";
import { buildFrontmatter, parseFrontmatter } from "../utils/markdown.js";
import { validateFieldsAgainstDefs } from "../profile/field-contract.js";
import { linkList, withGenerated, type PageLink } from "../wiki/generated-section.js";
import { CITED_BULLETS, mergeRanges, SUMMARY_PREFIX, type LineRange, type PageRequest, type ShownLines } from "../compiler/source-excerpt.js";
import type { DayBucket } from "../timeline/buckets.js";
import { dayCovers, formatDay } from "../timeline/pages.js";
import type { ExtractableType } from "./schema.js";
import type { ResolvedRecord } from "./identity.js";

/** Bump only when the page prompt or layout changes in a way every page must pick up; it regenerates every page. */
const RECORD_PAGE_VERSION = 1;
/** Lines of context shown on each side of a mention. */
const CONTEXT_LINES = 2;

/** What a record page records about itself in frontmatter. */
export interface RecordPageMeta {
  title: string;
  /** The type's title field, when it is not `title`; the name is written under it too. */
  titleField?: string;
  summary: string;
  aliases: string[];
  fields: Record<string, unknown>;
  /** The source files the page draws on; left out of the frontmatter when undefined. */
  sources?: string[];
  signature: string;
  createdAt: string;
  updatedAt: string;
  provenance: Record<string, unknown>;
}

/** The ranges the model is shown for a record: each mention with {@link CONTEXT_LINES} either side, merged per file. */
export function shownSources(record: ResolvedRecord, texts: Map<string, string>): ShownLines[] {
  const byFile = new Map<string, LineRange[]>();
  for (const mention of record.mentions) {
    const lineCount = (texts.get(mention.file) ?? "").split("\n").length;
    const widened = mention.lines.map((range) => ({ start: Math.max(1, range.start - CONTEXT_LINES), end: Math.min(lineCount, range.end + CONTEXT_LINES) }));
    byFile.set(mention.file, [...(byFile.get(mention.file) ?? []), ...widened]);
  }
  return [...byFile].sort(([a], [b]) => a.localeCompare(b)).map(([file, ranges]) => ({ file, ranges: mergeRanges(ranges) }));
}

/**
 * The record's declared fields agreed across its mentions: a list is the union of
 * every value; any other field is its most frequent valid value (ties go to the
 * value seen first). A value that breaks the field's contract is dropped.
 */
export function agreedFields(type: ExtractableType, record: ResolvedRecord): Record<string, unknown> {
  const agreed: Record<string, unknown> = {};
  for (const [name, def] of type.fields) {
    const values = record.mentions.map((mention) => mention.fields[name])
      .filter((value) => value !== null && value !== undefined && value !== "")
      .filter((value) => validateFieldsAgainstDefs({ [name]: value }, { [name]: def }, []).length === 0);
    if (values.length === 0) continue;
    agreed[name] = def.type === "string[]" ? [...new Set((values as string[][]).flat().map((item) => item.trim()).filter(Boolean))] : mostFrequent(values);
  }
  return agreed;
}

/** The most frequent value; ties go to the value seen first. */
function mostFrequent(values: unknown[]): unknown {
  const counts = new Map<string, { value: unknown; count: number }>();
  for (const value of values) {
    const key = JSON.stringify(value);
    counts.set(key, { value, count: (counts.get(key)?.count ?? 0) + 1 });
  }
  return [...counts.values()].reduce((best, entry) => (entry.count > best.count ? entry : best)).value;
}

/** Whether a page's frontmatter says compile wrote it (a record page or the owner page). */
export function isRecordPage(meta: Record<string, unknown>): boolean {
  return typeof meta.entitySignature === "string";
}

/** The signature of what a record page is generated from; equal signatures mean the page is current. */
export function recordSignature(title: string, fields: Record<string, unknown>, excerpt: string): string {
  return shortDigest([RECORD_PAGE_VERSION, title, fields, excerpt]);
}

/** The request for a record page. */
export function recordPageRequest(type: string, title: string, excerpt: string, ownerNames: string[]): PageRequest {
  const owner = ownerNames[0] ? ` The owner of this memory is ${ownerNames[0]}.` : "";
  const system = `Write a page about ${title}, a ${type} in a personal memory, from the records below, in the third person.${owner}
First line: "${SUMMARY_PREFIX} " and one sentence about who ${title} is.
${CITED_BULLETS}`;
  return { system, messages: [{ role: "user", content: `Records that mention ${title}:\n\n${excerpt}\n\nWrite the page about ${title}.` }] };
}

/** A record page's frontmatter, as written: deterministic except for the summary and the times. */
function recordFrontmatter(meta: RecordPageMeta): Record<string, unknown> {
  return {
    title: meta.title,
    ...namedBy(meta.titleField, meta.title),
    summary: meta.summary,
    ...(meta.aliases.length > 0 ? { aliases: meta.aliases } : {}),
    ...meta.fields,
    ...(meta.sources ? { sources: meta.sources } : {}),
    entitySignature: meta.signature,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ...meta.provenance,
  };
}

/**
 * Whether a page's frontmatter meets the type's field contract, reporting why
 * not. Checked before the model call, so a page that cannot be written costs none.
 */
export function meetsFieldContract(report: PageReport, id: string, meta: RecordPageMeta, def: EntityTypeDef): boolean {
  const violations = validateEntityFields(recordFrontmatter(meta), def);
  if (violations.length > 0) report.result.errors.push(`${report.label(id)} not written: ${violations.join(" ")}`);
  return violations.length === 0;
}

/** How compile names a type's pages in what it reports. */
export function entityReport(type: string, result: DerivedResult): PageReport {
  return { directory: type, writer: "entity extraction", label: (slug) => `Page "${type}/${slug}"`, id: (slug) => `${type}/${slug}`, result };
}

/** The name under the type's own title field, when that field is not `title`. */
function namedBy(titleField: string | undefined, title: string): Record<string, string> {
  return titleField && titleField !== "title" ? { [titleField]: title } : {};
}

/** The full markdown of a record page. */
export function recordPage(meta: RecordPageMeta, body: string, tail: string): string {
  return withGenerated(`${buildFrontmatter(recordFrontmatter(meta))}\n\n${body.trim()}\n`, tail);
}

/**
 * A record page with its `aliases` set to `aliases`, everything else unchanged.
 * Aliases come from how the sources wrote the record, not from what the model
 * was shown, so a change to them is applied here without regenerating the page.
 */
export function withAliases(text: string, aliases: string[]): string {
  const { meta } = parseFrontmatter(text);
  const current = Array.isArray(meta.aliases) ? meta.aliases : [];
  const end = frontmatterEnd(text);
  if (end === -1 || JSON.stringify(current) === JSON.stringify(aliases)) return text;
  const entries = Object.entries(meta).filter(([key]) => key !== "aliases");
  const at = Object.keys(meta).includes("aliases") ? Object.keys(meta).indexOf("aliases") : entries.findIndex(([key]) => key === "summary") + 1;
  if (aliases.length > 0) entries.splice(at, 0, ["aliases", aliases]);
  return buildFrontmatter(Object.fromEntries(entries)) + text.slice(end);
}

/** The timeline days a record is mentioned on, oldest first, as links to their pages. */
export function recordDays(record: ResolvedRecord, days: DayBucket[]): PageLink[] {
  return days.filter((day) => record.mentions.some((mention) => mention.lines.some((lines) => dayCovers(day, mention.file, lines))))
    .map((day) => ({ target: `timeline/${day.day}`, title: formatDay(day.day, false) }));
}

/** A record page's generated tail: the days it appears on, then the records it might be the same as. */
export function recordTail(days: PageLink[], maybeSame: PageLink[]): string {
  return [
    days.length > 0 ? `## Days\n\n${linkList(days)}` : "",
    maybeSame.length > 0
      ? `## Might be the same as\n\n${linkList(maybeSame)}\n\nNot merged. If they are one, list their names under one id in \`.llmwiki/aliases.json\`.`
      : "",
  ].filter(Boolean).join("\n\n");
}
