/**
 * @file src/catalog/rows.ts
 * @description Projections between files, catalog rows and the public `Page`
 * and `SourceRecord` shapes.
 *
 * A row is produced by the SAME projection the legacy listings use
 * (`buildPage` in `pages/list.ts`, `toRecord` in `sources/source-record.ts`),
 * so an indexed listing returns exactly the fields a legacy one would for the
 * same file. Rows read back from the store are validated strictly; a row of
 * the wrong shape is corruption, never a guess.
 */

import { asEntityDirRow, asEntityFileRow, isEntityDirKey } from "./entity-rows.js";
import { corrupt } from "../segments/contracts.js";
import { buildPage, type Page } from "../pages/list.js";
import { toRecord, type SourceRecord } from "../sources/source-record.js";
import { parseFrontmatter } from "../utils/markdown.js";
import type { PageDirectory } from "../export/types.js";
import { closed, isDirStamp, isFileStamp, type DirStamp, type FileStamp, type PageRowV1, type SourceRowV1 } from "./contracts.js";

/** Project a page file's text into its row. */
export function pageRowFrom(dir: PageDirectory, slug: string, text: string, stamp: FileStamp): PageRowV1 {
  const { meta, body } = parseFrontmatter(text);
  const page = buildPage(dir, slug, meta, body, false);
  return {
    title: page.title, summary: page.summary, tags: page.tags, links: page.links,
    ...(page.createdAt === undefined ? {} : { createdAt: page.createdAt }),
    ...(page.updatedAt === undefined ? {} : { updatedAt: page.updatedAt }),
    orphaned: page.orphaned, archived: page.archived, stamp,
  };
}

/** Project a source file's text into its row. */
export function sourceRowFrom(id: string, text: string, stamp: FileStamp): SourceRowV1 {
  const record = toRecord(id, text, false);
  return {
    title: record.title, source: record.source, sourceType: record.sourceType,
    ...(record.ingestedAt === undefined ? {} : { ingestedAt: record.ingestedAt }), stamp,
  };
}

/** The public page for a row, with `body` attached only when given. */
export function pageFromRow(dir: PageDirectory, slug: string, row: PageRowV1, body?: string): Page {
  return {
    slug, pageDirectory: dir, title: row.title, summary: row.summary, tags: [...row.tags], links: [...row.links],
    createdAt: row.createdAt, updatedAt: row.updatedAt, orphaned: row.orphaned, archived: row.archived,
    ...(body === undefined ? {} : { body }),
  };
}

/** The public source record for a row, with `body` attached only when given. */
export function sourceFromRow(id: string, row: SourceRowV1, body?: string): SourceRecord {
  return {
    id, title: row.title, source: row.source, sourceType: row.sourceType, ingestedAt: row.ingestedAt,
    ...(body === undefined ? {} : { body }),
  };
}

/** A body for `text`, as the legacy listings attach it. */
export function bodyOf(text: string): string {
  return parseFrontmatter(text).body;
}

/** Whether `value` is a list of strings. */
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Whether an optional field is absent or a string. */
function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

const PAGE_ROW_KEYS = ["title", "summary", "tags", "links", "orphaned", "archived", "stamp"] as const;
const SOURCE_ROW_KEYS = ["title", "source", "sourceType", "stamp"] as const;

/** Validate a stored page row (closed shape). */
export function asPageRow(value: unknown, key: string): PageRowV1 {
  const valid = closed(value, PAGE_ROW_KEYS, ["createdAt", "updatedAt"]) && typeof value.title === "string" && typeof value.summary === "string"
    && strings(value.tags) && strings(value.links) && typeof value.orphaned === "boolean" && typeof value.archived === "boolean"
    && isFileStamp(value.stamp) && optionalString(value.createdAt) && optionalString(value.updatedAt);
  if (!valid) corrupt(`catalog page row ${key} is malformed`);
  return value as unknown as PageRowV1;
}

/** Validate a stored source row (closed shape). */
export function asSourceRow(value: unknown, key: string): SourceRowV1 {
  const valid = closed(value, SOURCE_ROW_KEYS, ["ingestedAt"]) && typeof value.title === "string" && typeof value.source === "string"
    && typeof value.sourceType === "string" && isFileStamp(value.stamp) && optionalString(value.ingestedAt);
  if (!valid) corrupt(`catalog source row ${key} is malformed`);
  return value as unknown as SourceRowV1;
}

/** The stamp a stored row carries: a directory row's stamp (or null when the directory was absent), an entity row's, else the file stamp. */
export function stampOfRow(key: string, value: unknown): FileStamp | null {
  if (key.startsWith("e:")) return isEntityDirKey(key) ? asEntityDirRow(value, key).dir : asEntityFileRow(value, key).stamp;
  if (key.startsWith("d:")) {
    if (value !== null && !isDirStamp(value)) corrupt(`catalog directory row ${key} is malformed`);
    return value as DirStamp | null;
  }
  return key.startsWith("p:") ? asPageRow(value, key).stamp : asSourceRow(value, key).stamp;
}
