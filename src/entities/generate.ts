/**
 * @file src/entities/generate.ts
 * @description Compile's entity step: extract records of every opted-in entity
 * type from the sources, settle which names are the same record, and keep one
 * page per record in `wiki/<type>/`. The owner's own page is written after the
 * timeline, by owner.ts.
 *
 * Model calls are spent only where inputs changed. Extraction re-reads a source
 * only when its hash or the schema's structure changed (see extract.ts). A record
 * page is regenerated only when its signature, a hash of exactly what the model
 * would be shown, changed; otherwise only its aliases, citations (fitted to the
 * lines shown) and generated tail (days, possible duplicates) are refreshed,
 * with no model call.
 *
 * Pages this step did not write (no `entitySignature`) are never replaced or
 * deleted; a record whose page name is taken by one is reported. Generated pages
 * whose record is gone are removed. A failure is reported, never thrown, so the
 * compile still succeeds; the next compile retries.
 */

import pLimit, { type LimitFunction } from "p-limit";
import { withGenerated, type PageLink } from "../wiki/generated-section.js";
import type { CompilePageWrite } from "../compiler/compile-write.js";
import {
  claimable, completePage, createdAtOf, deleteAndReport, fitAndReportCitations, fitPageCitations, ownPages, readSources, stringField, writeAndReport,
  type DerivedResult, type DerivedSteps, type OwnPage, type PageReport,
} from "../compiler/derived-steps.js";
import { sourcesExcerpt, splitAnswer, type ShownLines } from "../compiler/source-excerpt.js";
import { dayBuckets, type DayBucket } from "../timeline/buckets.js";
import { mentionsOf, refreshExtractions, type ExtractionCache, type ExtractSteps } from "./extract.js";
import { displayName, ownerPageId, possibleDuplicates, resolveRecords, type AliasRegistry, type ResolvedRecord } from "./identity.js";
import type { ExtractableType } from "./schema.js";
import {
  agreedFields, entityReport, isRecordPage, meetsFieldContract, recordDays, recordPage, recordPageRequest, recordSignature, recordTail, shownSources, withAliases,
  type RecordPageMeta,
} from "./pages.js";

/** The reads, model calls and writes the entity step composes. */
export interface EntitySteps extends ExtractSteps, DerivedSteps {
  readCache(): Promise<ExtractionCache | null>;
  writeCache(cache: ExtractionCache): Promise<void>;
  readRegistry(): Promise<AliasRegistry>;
}

/** How the step runs. */
export interface EntityConfig {
  types: ExtractableType[];
  /** The timeline's zone, for each page's Days list; null when the timeline is off. */
  timeZone: string | null;
  concurrency: number;
}

/** What the step did, plus how many sources it read. */
export interface EntityResult extends DerivedResult {
  extracted: number;
}

/** What every type's pages are built from. */
interface StepContext {
  steps: EntitySteps;
  registry: AliasRegistry;
  texts: Map<string, string>;
  days: DayBucket[];
  limit: LimitFunction;
  result: EntityResult;
}

/** One type's pass: the step's context, the type, its pages on disk, its records' titles, and how it reports. */
interface TypeContext extends StepContext {
  type: ExtractableType;
  /** This step's own pages in the type's directory, by slug. */
  pages: Map<string, OwnPage>;
  /** Slugs of the pages this step did not write. */
  foreign: Set<string>;
  /** Record id → the name its page shows. */
  titles: Map<string, string>;
  report: PageReport;
}

/** Bring every opted-in type's pages up to date with the sources. */
export async function generateEntitiesWith(steps: EntitySteps, config: EntityConfig): Promise<EntityResult> {
  const result: EntityResult = { extracted: 0, written: [], deleted: [], errors: [] };
  if (config.types.length === 0) return result;
  const registry = await steps.readRegistry();
  result.errors.push(...unknownExcludeTypes(registry, config.types));
  const read = await readSources(steps);
  const extraction = await refreshExtractions(steps, {
    types: config.types, sources: read, previous: await steps.readCache(), ownerNames: registry.owner?.names ?? [], concurrency: config.concurrency,
  });
  result.extracted = extraction.extracted.length;
  result.errors.push(...extraction.errors);
  await steps.writeCache(extraction.cache);
  const step: StepContext = {
    steps, registry, result, limit: pLimit(config.concurrency),
    texts: new Map(read.map((source) => [source.file, source.text])), days: config.timeZone ? dayBuckets(read, config.timeZone) : [],
  };
  for (const type of config.types) await writeType(step, type, extraction.cache);
  return result;
}

/** A report for each `exclude` key that names no opted-in type, so a misspelled type is not silently ignored. */
function unknownExcludeTypes(registry: AliasRegistry, types: ExtractableType[]): string[] {
  const known = new Set(types.map(({ type }) => type));
  return Object.keys(registry.exclude ?? {}).filter((type) => !known.has(type))
    .map((type) => `.llmwiki/aliases.json excludes names from "${type}", which is not an extracted type; ignored`);
}

/** Write one type's record pages, and remove its pages for records that are gone (never the owner page). */
async function writeType(step: StepContext, type: ExtractableType, cache: ExtractionCache): Promise<void> {
  const records = resolveRecords(type.type, mentionsOf(cache, type.type), step.registry);
  const { own: pages, foreign } = ownPages(await step.steps.listPages(type.type), isRecordPage);
  const titles = new Map(records.map((record) => [record.id, displayName(record, step.registry.entities[type.type]?.[record.id])]));
  const ctx: TypeContext = { ...step, type, pages, foreign, titles, report: entityReport(type.type, step.result) };
  const duplicates = possibleDuplicates(records, step.registry.distinct?.[type.type]);
  const writable = records.filter((record) => claimable(ctx.report, record.id, foreign));
  const writes = await Promise.all(writable.map((record) => ctx.limit(() => planRecord(ctx, record, duplicates.get(record.id) ?? []))));
  await writeAndReport(ctx.report, ctx.steps, writes.filter((write): write is CompilePageWrite => write !== null));
  const ownerPage = ownerPageId(step.registry, type.type);
  const live = new Set([...records.map((record) => record.id), ...(ownerPage ? [ownerPage] : [])]);
  await deleteAndReport(ctx.report, ctx.steps, [...pages].filter(([slug]) => !live.has(slug))
    .map(([slug, page]) => ({ ...entityWrite(ctx, slug, page.text), deleting: true })));
}

/** What a record page is built from, before any model call. */
interface RecordDraft {
  record: ResolvedRecord;
  title: string;
  fields: Record<string, unknown>;
  excerpt: { text: string; shown: ShownLines[] };
  signature: string;
  tail: string;
}

/** The write for one record: a regenerated page, a refreshed tail and aliases, or nothing when the page is current. */
async function planRecord(ctx: TypeContext, record: ResolvedRecord, sameIds: string[]): Promise<CompilePageWrite | null> {
  const title = ctx.titles.get(record.id)!;
  const fields = agreedFields(ctx.type, record);
  const excerpt = sourcesExcerpt(shownSources(record, ctx.texts), ctx.texts);
  const maybeSame: PageLink[] = sameIds.map((id) => ({ target: `${ctx.type.type}/${id}`, title: ctx.titles.get(id) ?? id }));
  const draft: RecordDraft = { record, title, fields, excerpt, signature: recordSignature(title, fields, excerpt.text), tail: recordTail(recordDays(record, ctx.days), maybeSame) };
  const page = ctx.pages.get(record.id);
  if (!page || stringField(page.meta, "entitySignature") !== draft.signature) return regenerate(ctx, draft, page);
  const text = withGenerated(withAliases(fitPageCitations(page.text, excerpt.shown), aliasesOf(record, title, fields)), draft.tail);
  return text === page.text ? null : entityWrite(ctx, record.id, text);
}

/**
 * A record page written by the model from its draft, or no write after recording
 * why. The frontmatter is checked against the type's field contract BEFORE the
 * model call, so a page that cannot be written costs no call.
 */
async function regenerate(ctx: TypeContext, draft: RecordDraft, page: OwnPage | undefined): Promise<CompilePageWrite | null> {
  const { record } = draft;
  const meta = recordMeta(ctx, draft, page);
  if (!meetsFieldContract(ctx.report, record.id, meta, ctx.type.def)) return null;
  const request = recordPageRequest(ctx.type.type, draft.title, draft.excerpt.text, ctx.registry.owner?.names ?? []);
  const answer = await completePage(ctx.report, (req) => ctx.steps.complete({ ...req, tools: [] }), request, record.id);
  if (answer === null) return null;
  const { summary, body } = splitAnswer(fitAndReportCitations(ctx.report, record.id, answer, draft.excerpt.shown));
  return entityWrite(ctx, record.id, recordPage({ ...meta, summary }, body, draft.tail));
}

/** A record page's frontmatter fields, with the summary still to come. */
function recordMeta(ctx: TypeContext, draft: RecordDraft, page: OwnPage | undefined): RecordPageMeta {
  const { record, title, fields } = draft;
  const now = ctx.steps.now();
  return {
    title, titleField: ctx.type.def.titleField, summary: "", aliases: aliasesOf(record, title, fields), fields: withoutAliases(fields),
    signature: draft.signature, sources: [...new Set(record.mentions.map((mention) => mention.file))].sort(),
    createdAt: createdAtOf(page, now), updatedAt: now, provenance: ctx.steps.provenance(),
  };
}

/** Every other name the record went by, how the sources wrote it, and any `aliases` the sources gave. */
function aliasesOf(record: ResolvedRecord, title: string, fields: Record<string, unknown>): string[] {
  const given = Array.isArray(fields.aliases) ? fields.aliases as string[] : [];
  return [...new Set([...record.names, ...record.writtenAs, ...given])].filter((name) => name !== title);
}

/** The agreed fields without `aliases`, which the page carries from {@link aliasesOf}. */
function withoutAliases(fields: Record<string, unknown>): Record<string, unknown> {
  const { aliases: _aliases, ...rest } = fields;
  return rest;
}

/** A page write for `id` in the type's directory. */
function entityWrite(ctx: TypeContext, id: string, text: string): CompilePageWrite {
  return { entityType: ctx.type.type, slug: id, body: text };
}

