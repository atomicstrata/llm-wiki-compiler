/**
 * @file src/entities/generate.ts
 * @description Compile's entity step: extract records of every opted-in entity
 * type from the sources, settle which names are the same record, and keep one
 * page per record in `wiki/<type>/`, plus the owner's hub page.
 *
 * Model calls are spent only where inputs changed. Extraction re-reads a source
 * only when its hash or the schema's structure changed (see extract.ts). A record
 * page is regenerated only when its signature, a hash of exactly what the model
 * would be shown, changed; otherwise only its generated tail (days, possible
 * duplicates) is refreshed, with no model call. The hub has no model call.
 *
 * Pages this step did not write (no `entitySignature`) are never replaced or
 * deleted; a record whose page name is taken by one is reported. Generated pages
 * whose record is gone are removed. A failure is reported, never thrown, so the
 * compile still succeeds; the next compile retries.
 */

import pLimit from "p-limit";
import { parseFrontmatter } from "../utils/markdown.js";
import { validateEntityFields } from "../profile/field-contract.js";
import { withGenerated } from "../wiki/generated-section.js";
import type { CompilePageWrite } from "../compiler/compile-write.js";
import { applyWrites, type DerivedSteps } from "../compiler/derived-steps.js";
import { dayBuckets, type DayBucket } from "../timeline/buckets.js";
import { citationsOutside } from "../timeline/pages.js";
import { sourcesExcerpt, splitAnswer } from "../timeline/prompts.js";
import { refreshExtractions, type ExtractionCache, type ExtractSteps } from "./extract.js";
import { displayName, hubId, possibleDuplicates, resolveRecords, type AliasRegistry, type Mention, type ResolvedRecord } from "./identity.js";
import type { ExtractableType } from "./schema.js";
import {
  agreedFields, hubBody, hubPage, hubSignature, recordDays, recordFrontmatter, recordPage, recordPageRequest, recordSignature, recordTail, shownSources,
  type HubEntry, type PageLink, type RecordPageMeta,
} from "./pages.js";

/** The reads, model calls and writes the entity step composes. */
export interface EntitySteps extends ExtractSteps, DerivedSteps {
  readCache(): Promise<ExtractionCache | null>;
  writeCache(cache: ExtractionCache): Promise<void>;
  readRegistry(): Promise<AliasRegistry>;
  /** The pages in `wiki/<type>/`: slug → text. */
  listPages(type: string): Promise<Map<string, string>>;
}

/** How the step runs. */
export interface EntityConfig {
  types: ExtractableType[];
  /** The timeline's zone, for each page's Days list; null when the timeline is off. */
  timeZone: string | null;
  concurrency: number;
}

/** What the step did. */
export interface EntityResult {
  extracted: number;
  written: string[];
  deleted: string[];
  errors: string[];
}

/** Everything one type's pages are built from. */
interface TypeContext {
  steps: EntitySteps;
  type: ExtractableType;
  registry: AliasRegistry;
  texts: Map<string, string>;
  days: DayBucket[];
  limit: ReturnType<typeof pLimit>;
  result: EntityResult;
}

/** A page this step wrote before: its text, signature and creation time. */
interface ExistingPage { text: string; signature: string; createdAt: string; summary: string }

/** One planned page write, with the summary the hub shows for it. */
type PlannedWrite = { write: CompilePageWrite | null; id: string; summary: string };

/** Bring every opted-in type's pages up to date with the sources. */
export async function generateEntitiesWith(steps: EntitySteps, config: EntityConfig): Promise<EntityResult> {
  const result: EntityResult = { extracted: 0, written: [], deleted: [], errors: [] };
  if (config.types.length === 0) return result;
  const sources = await steps.listSources();
  const registry = await steps.readRegistry();
  const extraction = await refreshExtractions(steps, config.types, sources, await steps.readCache(), registry.owner?.names ?? [], config.concurrency);
  result.extracted = extraction.extracted.length;
  result.errors.push(...extraction.errors);
  await steps.writeCache(extraction.cache);
  const read = await Promise.all(sources.map(async (source) => ({ ...source, text: await steps.readSource(source.file) })));
  const texts = new Map(read.map((source) => [source.file, source.text]));
  const days = config.timeZone ? dayBuckets(read, config.timeZone) : [];
  const limit = pLimit(Math.max(1, config.concurrency));
  for (const type of config.types) {
    await writeType({ steps, type, registry, texts, days, limit, result }, mentionsOf(extraction.cache, type.type));
  }
  return result;
}

/** Every mention of `type` across the cached sources. */
export function mentionsOf(cache: ExtractionCache, type: string): Mention[] {
  return Object.entries(cache.sources).sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([file, entry]) => entry.chunks.flatMap((chunk) => (chunk.records[type] ?? []).map((record) => ({ file, ...record }))));
}

/** Write one type's record pages and hub, and remove its pages for records that are gone. */
async function writeType(ctx: TypeContext, mentions: Mention[]): Promise<void> {
  const records = resolveRecords(ctx.type.type, mentions, ctx.registry);
  const { pages, foreign } = existingPages(await ctx.steps.listPages(ctx.type.type));
  const titles = new Map(records.map((record) => [record.id, displayName(record, ctx.registry.entities[ctx.type.type]?.[record.id])]));
  const duplicates = possibleDuplicates(records);
  const writable = records.filter((record) => isWritable(ctx, record.id, foreign));
  const planned = await Promise.all(writable.map((record) => ctx.limit(() => planRecord(ctx, record, pages.get(record.id), titles, duplicates.get(record.id) ?? []))));
  const landed = await commit(ctx, planned);
  const hubId = await writeHub(ctx, planned.filter((plan) => landed.has(plan.id)), titles, pages, foreign);
  await deleteGone(ctx, pages, new Set([...records.map((record) => record.id), ...(hubId ? [hubId] : [])]));
}

/** The pages this step wrote, by slug, and the slugs of the others. */
function existingPages(texts: Map<string, string>): { pages: Map<string, ExistingPage>; foreign: Set<string> } {
  const pages = new Map<string, ExistingPage>();
  const foreign = new Set<string>();
  for (const [slug, text] of texts) {
    const { meta } = parseFrontmatter(text);
    if (typeof meta.entitySignature !== "string") { foreign.add(slug); continue; }
    pages.set(slug, {
      text, signature: meta.entitySignature,
      createdAt: typeof meta.createdAt === "string" ? meta.createdAt : "",
      summary: typeof meta.summary === "string" ? meta.summary : "",
    });
  }
  return { pages, foreign };
}

/** Whether a page may be written under `id`: not when a page this step did not write holds the name. */
function isWritable(ctx: TypeContext, id: string, foreign: ReadonlySet<string>): boolean {
  if (!foreign.has(id)) return true;
  ctx.result.errors.push(`wiki/${ctx.type.type}/${id}.md was not written by entity extraction; left as it is`);
  return false;
}

/** What a record page is built from, before any model call. */
interface RecordDraft {
  record: ResolvedRecord;
  title: string;
  fields: Record<string, unknown>;
  excerpt: { text: string; shown: { file: string; ranges: { start: number; end: number }[] }[] };
  signature: string;
  tail: string;
}

/** The write for one record: a regenerated page, a refreshed tail, or nothing when the page is current. */
async function planRecord(ctx: TypeContext, record: ResolvedRecord, page: ExistingPage | undefined, titles: Map<string, string>, sameIds: string[]): Promise<PlannedWrite> {
  const title = titles.get(record.id)!;
  const fields = agreedFields(ctx.type, record);
  const excerpt = sourcesExcerpt(shownSources(record, ctx.texts), ctx.texts);
  const maybeSame: PageLink[] = sameIds.map((id) => ({ target: `${ctx.type.type}/${id}`, title: titles.get(id) ?? id }));
  const draft: RecordDraft = { record, title, fields, excerpt, signature: recordSignature(title, fields, excerpt.text), tail: recordTail(recordDays(record, ctx.days), maybeSame) };
  if (page?.signature !== draft.signature) return regenerate(ctx, draft, page);
  const text = withGenerated(page.text, draft.tail);
  return { id: record.id, summary: page.summary, write: text === page.text ? null : entityWrite(ctx, record.id, text) };
}

/**
 * A record page written by the model from its draft, or no write after recording
 * why. The frontmatter is checked against the type's field contract BEFORE the
 * model call, so a page that cannot be written costs no call.
 */
async function regenerate(ctx: TypeContext, draft: RecordDraft, page: ExistingPage | undefined): Promise<PlannedWrite> {
  const { record } = draft;
  const meta = recordMeta(ctx, draft, page);
  const violations = validateEntityFields(recordFrontmatter(meta), ctx.type.def);
  if (violations.length > 0) {
    ctx.result.errors.push(`Page "${ctx.type.type}/${record.id}" not written: ${violations.join(" ")}`);
    return { id: record.id, summary: page?.summary ?? "", write: null };
  }
  const answer = await completeOrRecord(ctx, recordPageRequest(ctx.type.type, draft.title, draft.excerpt.text, ctx.registry.owner?.names ?? []), record.id);
  if (answer === null) return { id: record.id, summary: page?.summary ?? "", write: null };
  const { summary, body } = splitAnswer(answer);
  reportStrayCitations(ctx, record.id, body, draft);
  return { id: record.id, summary, write: entityWrite(ctx, record.id, recordPage({ ...meta, summary }, body, draft.tail)) };
}

/** A record page's frontmatter fields, with the summary still to come. */
function recordMeta(ctx: TypeContext, draft: RecordDraft, page: ExistingPage | undefined): RecordPageMeta {
  const { record, title, fields } = draft;
  const now = ctx.steps.now();
  return {
    title, titleField: ctx.type.def.titleField, summary: "", aliases: aliasesOf(record, title, fields), fields: withoutAliases(fields),
    signature: draft.signature, sources: [...new Set(record.mentions.map((mention) => mention.file))].sort(),
    createdAt: page?.createdAt || now, updatedAt: now, provenance: ctx.steps.provenance(),
  };
}

/** Record a page that cites lines it was not shown. The page is still written; the compile output names it. */
function reportStrayCitations(ctx: TypeContext, id: string, body: string, draft: RecordDraft): void {
  const stray = citationsOutside(body, [{ sources: draft.excerpt.shown }]);
  if (stray > 0) ctx.result.errors.push(`Page "${ctx.type.type}/${id}" cites ${stray} span(s) outside the lines it was written from`);
}

/** Every other name the record went by, with any `aliases` the sources gave. */
function aliasesOf(record: ResolvedRecord, title: string, fields: Record<string, unknown>): string[] {
  const given = Array.isArray(fields.aliases) ? fields.aliases as string[] : [];
  return [...new Set([...record.names, ...given])].filter((name) => name !== title);
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

/** The write, or null after recording that the page breaks the type's field contract. */
function validWrite(ctx: TypeContext, id: string, text: string): CompilePageWrite | null {
  const violations = validateEntityFields(parseFrontmatter(text).meta, ctx.type.def);
  if (violations.length === 0) return entityWrite(ctx, id, text);
  ctx.result.errors.push(`Page "${ctx.type.type}/${id}" not written: ${violations.join(" ")}`);
  return null;
}

/** The model's answer, or null after recording why there is none. */
async function completeOrRecord(ctx: TypeContext, request: { system: string; messages: { role: "user"; content: string }[] }, id: string): Promise<string | null> {
  try {
    const answer = await ctx.steps.complete({ ...request, tools: [] });
    if (splitAnswer(answer).body) return answer;
    ctx.result.errors.push(`Page "${ctx.type.type}/${id}" came back empty`);
  } catch (error) {
    ctx.result.errors.push(`Page "${ctx.type.type}/${id}" failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return null;
}

/** Apply the planned writes; returns the ids whose page exists after them. */
async function commit(ctx: TypeContext, planned: PlannedWrite[]): Promise<Set<string>> {
  const { landed, blocked } = await applyWrites(ctx.steps, planned.flatMap((plan) => (plan.write ? [plan.write] : [])));
  for (const write of blocked) ctx.result.errors.push(`Page "${ctx.type.type}/${write.slug}" skipped by the write floor`);
  ctx.result.written.push(...landed.map((write) => `${ctx.type.type}/${write.slug}`));
  const pageIds = new Set((await ctx.steps.listPages(ctx.type.type)).keys());
  const blockedIds = new Set(blocked.map((write) => write.slug));
  return new Set(planned.map((plan) => plan.id).filter((id) => pageIds.has(id) && !blockedIds.has(id)));
}

/** Write the owner's hub when the owner is of this type; returns its id, or null when there is none. */
async function writeHub(ctx: TypeContext, planned: PlannedWrite[], titles: Map<string, string>, pages: Map<string, ExistingPage>, foreign: Set<string>): Promise<string | null> {
  const owner = hubOwner(ctx, foreign);
  if (!owner) return null;
  const groupField = Object.entries(ctx.type.def.fields ?? {}).find(([name, def]) => def.type === "enum" && name !== ctx.type.def.titleField);
  const entries = hubEntries(ctx, planned, titles, pages, groupField?.[0]);
  const body = hubBody(entries, groupField?.[1].enum ?? []);
  const existing = pages.get(owner.id);
  if (existing?.signature === hubSignature(body)) return owner.id;
  const now = ctx.steps.now();
  const text = hubPage({
    title: owner.names[0], titleField: ctx.type.def.titleField, aliases: owner.names.slice(1), count: entries.length, type: ctx.type.type,
    createdAt: existing?.createdAt || now, updatedAt: now,
  }, body);
  await commit(ctx, [{ id: owner.id, summary: "", write: validWrite(ctx, owner.id, text) }]);
  return owner.id;
}

/** The owner's hub id and names, when the owner is of this type and the hub's page name is free. */
function hubOwner(ctx: TypeContext, foreign: Set<string>): { id: string; names: string[] } | null {
  const id = hubId(ctx.registry, ctx.type.type);
  return id && isWritable(ctx, id, foreign) ? { id, names: ctx.registry.owner!.names } : null;
}

/** The hub's entries: each record with a page, its summary, and its value of the grouping field. */
function hubEntries(ctx: TypeContext, planned: PlannedWrite[], titles: Map<string, string>, pages: Map<string, ExistingPage>, groupField: string | undefined): HubEntry[] {
  return planned.map((plan) => ({
    target: `${ctx.type.type}/${plan.id}`, title: titles.get(plan.id) ?? plan.id, summary: plan.summary,
    group: groupField ? groupOf(plan, groupField, pages) : null,
  }));
}

/** A record's value of the hub's grouping field, from the page just written or the one on disk. */
function groupOf(plan: PlannedWrite, field: string, pages: Map<string, ExistingPage>): string | null {
  const text = plan.write?.body ?? pages.get(plan.id)?.text ?? "";
  const value = parseFrontmatter(text).meta[field];
  return typeof value === "string" ? value : null;
}

/** Remove generated pages whose record is gone. */
async function deleteGone(ctx: TypeContext, pages: Map<string, ExistingPage>, live: Set<string>): Promise<void> {
  const writes = [...pages].filter(([slug]) => !live.has(slug))
    .map(([slug, page]): CompilePageWrite => ({ entityType: ctx.type.type, slug, body: page.text, deleting: true }));
  const { landed, blocked } = await applyWrites(ctx.steps, writes);
  for (const write of blocked) ctx.result.errors.push(`Page "${ctx.type.type}/${write.slug}" not removed`);
  ctx.result.deleted.push(...landed.map((write) => `${ctx.type.type}/${write.slug}`));
}
