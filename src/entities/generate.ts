/**
 * @file src/entities/generate.ts
 * @description Compile's entity step: extract records of every opted-in entity
 * type from the sources, settle which names are the same record, and keep one
 * page per record in `wiki/<type>/`, plus the owner's hub page.
 *
 * Model calls are spent only where inputs changed. Extraction re-reads a source
 * only when its hash or the schema's structure changed (see extract.ts). A record
 * page is regenerated only when its signature, a hash of exactly what the model
 * would be shown, changed; otherwise only its aliases, citations (fitted to the
 * lines shown) and generated tail (days, possible duplicates) are refreshed,
 * with no model call. The hub has no model
 * call.
 *
 * Pages this step did not write (no `entitySignature`) are never replaced or
 * deleted; a record whose page name is taken by one is reported. Generated pages
 * whose record is gone are removed. A failure is reported, never thrown, so the
 * compile still succeeds; the next compile retries.
 */

import pLimit, { type LimitFunction } from "p-limit";
import { parseFrontmatter } from "../utils/markdown.js";
import { validateEntityFields } from "../profile/field-contract.js";
import { withGenerated, type PageLink } from "../wiki/generated-section.js";
import type { CompilePageWrite } from "../compiler/compile-write.js";
import {
  claimable, completePage, deleteAndReport, fitAndReportCitations, fitPageCitations, ownPages, readSources, stringField, writeAndReport,
  type DerivedResult, type DerivedSteps, type OwnPage, type PageReport,
} from "../compiler/derived-steps.js";
import { sourcesExcerpt, splitAnswer } from "../compiler/source-excerpt.js";
import { dayBuckets, type DayBucket } from "../timeline/buckets.js";
import { mentionsOf, refreshExtractions, type ExtractionCache, type ExtractSteps } from "./extract.js";
import { displayName, hubId, possibleDuplicates, resolveRecords, type AliasRegistry, type ResolvedRecord } from "./identity.js";
import type { ExtractableType } from "./schema.js";
import {
  agreedFields, hubBody, hubPage, hubSignature, isRecordPage, recordDays, recordFrontmatter, recordPage, recordPageRequest, recordSignature, recordTail, shownSources, withAliases,
  type HubEntry, type RecordPageMeta, type ShownSource,
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

/** What the step did: the timeline's report, plus how many sources it read. */
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

/** One record's outcome: its id, the write (or none), and the frontmatter its page has after it. */
interface PlannedWrite {
  id: string;
  write: CompilePageWrite | null;
  meta: Record<string, unknown>;
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
    steps, registry, result, limit: pLimit(Math.max(1, config.concurrency)),
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

/** Write one type's record pages and hub, and remove its pages for records that are gone. */
async function writeType(step: StepContext, type: ExtractableType, cache: ExtractionCache): Promise<void> {
  const records = resolveRecords(type.type, mentionsOf(cache, type.type), step.registry);
  const { own: pages, foreign } = ownPages(await step.steps.listPages(type.type), isRecordPage);
  const titles = new Map(records.map((record) => [record.id, displayName(record, step.registry.entities[type.type]?.[record.id])]));
  const ctx: TypeContext = { ...step, type, pages, foreign, titles, report: entityReport(type.type, step.result) };
  const duplicates = possibleDuplicates(records, step.registry.distinct?.[type.type]);
  const writable = records.filter((record) => claimable(ctx.report, record.id, foreign));
  const planned = await Promise.all(writable.map((record) => ctx.limit(() => planRecord(ctx, record, duplicates.get(record.id) ?? []))));
  const withPages = await commit(ctx, planned);
  const hub = await writeHub(ctx, withPages);
  const live = new Set([...records.map((record) => record.id), ...(hub ? [hub] : [])]);
  await deleteAndReport(ctx.report, ctx.steps, [...pages].filter(([slug]) => !live.has(slug))
    .map(([slug, page]) => ({ ...entityWrite(ctx, slug, page.text), deleting: true })));
}

/** How the entity step names a type's pages in what it reports. */
function entityReport(type: string, result: DerivedResult): PageReport {
  return { directory: type, writer: "entity extraction", label: (slug) => `Page "${type}/${slug}"`, id: (slug) => `${type}/${slug}`, result };
}

/** What a record page is built from, before any model call. */
interface RecordDraft {
  record: ResolvedRecord;
  title: string;
  fields: Record<string, unknown>;
  excerpt: { text: string; shown: ShownSource[] };
  signature: string;
  tail: string;
}

/** The write for one record: a regenerated page, a refreshed tail and aliases, or nothing when the page is current. */
async function planRecord(ctx: TypeContext, record: ResolvedRecord, sameIds: string[]): Promise<PlannedWrite> {
  const title = ctx.titles.get(record.id)!;
  const fields = agreedFields(ctx.type, record);
  const excerpt = sourcesExcerpt(shownSources(record, ctx.texts), ctx.texts);
  const maybeSame: PageLink[] = sameIds.map((id) => ({ target: `${ctx.type.type}/${id}`, title: ctx.titles.get(id) ?? id }));
  const draft: RecordDraft = { record, title, fields, excerpt, signature: recordSignature(title, fields, excerpt.text), tail: recordTail(recordDays(record, ctx.days), maybeSame) };
  const page = ctx.pages.get(record.id);
  if (!page || stringField(page.meta, "entitySignature") !== draft.signature) return regenerate(ctx, draft, page);
  const text = withGenerated(withAliases(fitPageCitations(page.text, excerpt.shown), aliasesOf(record, title, fields)), draft.tail);
  return { id: record.id, write: text === page.text ? null : entityWrite(ctx, record.id, text), meta: page.meta };
}

/**
 * A record page written by the model from its draft, or no write after recording
 * why. The frontmatter is checked against the type's field contract BEFORE the
 * model call, so a page that cannot be written costs no call.
 */
async function regenerate(ctx: TypeContext, draft: RecordDraft, page: OwnPage | undefined): Promise<PlannedWrite> {
  const { record } = draft;
  const unchanged: PlannedWrite = { id: record.id, write: null, meta: page?.meta ?? {} };
  const meta = recordMeta(ctx, draft, page);
  const violations = validateEntityFields(recordFrontmatter(meta), ctx.type.def);
  if (violations.length > 0) {
    ctx.result.errors.push(`${ctx.report.label(record.id)} not written: ${violations.join(" ")}`);
    return unchanged;
  }
  const request = recordPageRequest(ctx.type.type, draft.title, draft.excerpt.text, ctx.registry.owner?.names ?? []);
  const answer = await completePage(ctx.report, (req) => ctx.steps.complete({ ...req, tools: [] }), request, record.id);
  if (answer === null) return unchanged;
  const { summary, body } = splitAnswer(fitAndReportCitations(ctx.report, record.id, answer, draft.excerpt.shown));
  const written = { ...meta, summary };
  return { id: record.id, write: entityWrite(ctx, record.id, recordPage(written, body, draft.tail)), meta: recordFrontmatter(written) };
}

/** A record page's frontmatter fields, with the summary still to come. */
function recordMeta(ctx: TypeContext, draft: RecordDraft, page: OwnPage | undefined): RecordPageMeta {
  const { record, title, fields } = draft;
  const now = ctx.steps.now();
  return {
    title, titleField: ctx.type.def.titleField, summary: "", aliases: aliasesOf(record, title, fields), fields: withoutAliases(fields),
    signature: draft.signature, sources: [...new Set(record.mentions.map((mention) => mention.file))].sort(),
    createdAt: stringField(page?.meta ?? {}, "createdAt") || now, updatedAt: now, provenance: ctx.steps.provenance(),
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

/**
 * Apply the planned writes; returns the plans whose page exists after them. A
 * plan with no write has a page only when this step wrote one before (foreign
 * names never get a plan); a plan with a write has one unless the floor skipped it.
 */
async function commit(ctx: TypeContext, planned: PlannedWrite[]): Promise<PlannedWrite[]> {
  const landed = new Set(await writeAndReport(ctx.report, ctx.steps, planned.flatMap((plan) => (plan.write ? [plan.write] : []))));
  return planned.filter((plan) => (plan.write ? landed.has(plan.write) : ctx.pages.has(plan.id)));
}

/** Write the owner's hub when the owner is of this type; returns its id, or null when there is none. */
async function writeHub(ctx: TypeContext, planned: PlannedWrite[]): Promise<string | null> {
  const id = hubId(ctx.registry, ctx.type.type);
  if (!id || !claimable(ctx.report, id, ctx.foreign)) return null;
  const groupField = Object.entries(ctx.type.def.fields ?? {}).find(([name, def]) => def.type === "enum" && name !== ctx.type.def.titleField);
  const body = hubBody(hubEntries(ctx, planned, groupField?.[0]), groupField?.[1].enum ?? []);
  const existing = ctx.pages.get(id);
  if (!existing || stringField(existing.meta, "entitySignature") !== hubSignature(body)) await writeHubPage(ctx, id, body, planned.length);
  return id;
}

/** The hub's entries: each record with a page, its summary, and its value of the grouping field. */
function hubEntries(ctx: TypeContext, planned: PlannedWrite[], groupField: string | undefined): HubEntry[] {
  return planned.map((plan) => ({
    target: `${ctx.type.type}/${plan.id}`, title: ctx.titles.get(plan.id) ?? plan.id, summary: stringField(plan.meta, "summary"),
    group: groupField ? stringField(plan.meta, groupField) || null : null,
  }));
}

/** Write the hub page with `body`, keeping its creation time, unless it would break the type's field contract. */
async function writeHubPage(ctx: TypeContext, id: string, body: string, count: number): Promise<void> {
  const names = ctx.registry.owner!.names;
  const now = ctx.steps.now();
  const text = hubPage({
    title: names[0], titleField: ctx.type.def.titleField, aliases: names.slice(1), count, type: ctx.type.type,
    createdAt: stringField(ctx.pages.get(id)?.meta ?? {}, "createdAt") || now, updatedAt: now,
  }, body);
  const violations = validateEntityFields(parseFrontmatter(text).meta, ctx.type.def);
  if (violations.length > 0) ctx.result.errors.push(`${ctx.report.label(id)} not written: ${violations.join(" ")}`);
  else await writeAndReport(ctx.report, ctx.steps, [entityWrite(ctx, id, text)]);
}
