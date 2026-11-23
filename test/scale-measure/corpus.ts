/**
 * @file test/scale-measure/corpus.ts
 * @description Build phases of a measurement corpus, each through the REAL
 * selected route of an ordinary project (never by writing segment files or
 * manifests):
 *
 * - `init`: `initWikiCore` with an expected scale (on an empty project this
 *   prepares and activates the planned architecture);
 * - `sources`: SDK `ingestText` (catalog write-through on `local-indexed`);
 *   lengths cycle 33,000 / 64,000 / 95,000 characters (mean about 62.5 KiB,
 *   under the 100,000-character source cap);
 * - `pages`: page FILES (files are the truth) reconciled by `catalog.sync`;
 *   each page body splits into exactly `chunksPerDoc` retrieval chunks;
 * - `vectors`: the routed embedding writer (`updateEmbeddings`) with the
 *   offline embedding double; the stored page and chunk counts and the
 *   vector width are then read back from the actual store and asserted
 *   (vectors per document = 1 page vector + `chunksPerDoc` chunk vectors);
 * - `events`: `appendEvent`, `eventsPerDoc` per document;
 * - `relations`: the relation store API with a declared synthetic profile
 *   pack (relation writes are profile-gated; on a default-profile project
 *   they are reachable only as this direct API composition), plus one
 *   operation-bound relation whose mutation the lookups use;
 * - `opcat`: workspace operation-catalog appends (the catalog adapter's
 *   writer), each under the gated project lock as an operation holds it;
 * - `compile`: SDK `compile` with the offline provider (schema-empty
 *   extractions). Empty extractions are never recorded as processed, so this
 *   does NOT make a later compile a no-op: that needs `noop-checkpoint`;
 * - `migrate`: on an incumbent (`local-standard`) project, `scale.set` to an
 *   indexed expected scale: the real preparation (catalog build, history and
 *   vector imports within the legacy format caps, verification, activation);
 * - `noop-checkpoint`: a DECLARED SYNTHETIC processed-source state written
 *   through the real state writer, run in its own child before the timed
 *   no-op compile (so its preparation is never measured as compilation).
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashFile } from "../../src/compiler/hasher.js";
import { promptModifiersDigest } from "../../src/compiler/prompt-modifiers.js";
import { appendEvent } from "../../src/events/store.js";
import { appendCatalogRecordLocked, createCatalogRecord } from "../../src/operation-bundles/catalog-store.js";
import { acquireMutationLockBlocking } from "../../src/operation-bundles/lock-gate.js";
import { releaseLock } from "../../src/utils/lock.js";
import type { EntityId, ProfilePack } from "../../src/profile/types.js";
import { appendRelationForOperationLocked } from "../../src/relations/operation-write.js";
import { appendRelation } from "../../src/relations/store.js";
import { createWikiCore, initWikiCore } from "../../src/sdk/core.js";
import { updateEmbeddings } from "../../src/utils/embeddings.js";
import { loadEmbeddingsForSearch } from "../../src/utils/embeddings-load.js";
import { isShardedView } from "../../src/vectors/store.js";
import type { PageId } from "../../src/utils/page-id.js";
import { applyPromptModifiers, applySourceState, readState, writeState } from "../../src/utils/state.js";
import { CHUNK_TARGET_CHARS } from "../../src/utils/constants.js";

/** The shape of one measurement corpus. */
export interface CorpusShape {
  readonly docs: number;
  readonly chunksPerDoc: number;
  readonly eventsPerDoc: number;
  readonly relationsPerDoc: number;
  readonly expectedDocuments: number;
}

/** The synthetic relation pack: one directed `tests` relation, experiments to ideas (declared here: children cannot load vitest fixtures). */
export const MEASURE_PROFILE: ProfilePack = {
  schemaVersion: 1, profileId: "research",
  entities: { experiments: { directory: "wiki/experiments" }, ideas: { directory: "wiki/ideas" } },
  relations: { tests: { from: ["experiments"], to: ["ideas"], direction: "directed" } },
};
const EXPERIMENT = "experiments/a" as EntityId;
/** The operation binding of the one operation-bound relation. */
export const MEASURE_BINDING = { bundleId: "bnd_01ARZ3NDEKTSV4RRFFQ69G5FAV", runId: "opr_01ARZ3NDEKTSV4RRFFQ69G5FAV", mutationId: `opm_${"c".repeat(64)}` } as const;
/** The workspace the operation-catalog phase appends to. */
export const MEASURE_WORKSPACE = "measure";
const SOURCE_LENGTHS = [33_000, 64_000, 95_000];
/** The vector width every measured corpus is embedded at. */
export const MEASURE_VECTOR_DIMENSIONS = 1536;
/** The expected scale a migration requests (inside the indexed planning bound). */
const MIGRATE_DOCUMENTS = 10_000;
const AT = "2026-10-26T00:00:00.000Z";

/** Deterministic filler text of exactly `length` characters. */
function filler(seed: string, length: number): string {
  const unit = `${seed} lorem ipsum dolor sit amet consectetur adipiscing elit `;
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

/** The relation input to idea `n` of document `doc`. */
export function relationTo(doc: number, n: number) {
  return { type: "tests", from: EXPERIMENT, to: `ideas/d${doc}-${n}` as EntityId, attributes: {} };
}

/** Page `doc`'s file text: `chunks` paragraphs that never merge (each over half the chunk target). */
export function pageText(doc: number, chunks: number, summary = `About document ${doc}`): string {
  const paragraphs = Array.from({ length: chunks }, (_, at) => filler(`d${doc}p${at}`, Math.floor(CHUNK_TARGET_CHARS * 0.8)));
  return `---\ntitle: Document ${doc}\nsummary: ${summary}\n---\n\n${paragraphs.join("\n\n")}\n`;
}

/** Run `write` under the gated project lock, as an operation's executor holds it around a `*Locked` writer. */
export async function underProjectLock<T>(root: string, write: () => Promise<T>): Promise<T> {
  await acquireMutationLockBlocking(root, "ordinary");
  try {
    return await write();
  } finally {
    await releaseLock(root);
  }
}

/** Ingest every source through the SDK. */
async function buildSources(root: string, shape: CorpusShape): Promise<Record<string, number>> {
  const wiki = createWikiCore({ root });
  for (let doc = 0; doc < shape.docs; doc += 1) {
    await wiki.ingestText({ title: `Source ${doc}`, text: filler(`s${doc}`, SOURCE_LENGTHS[doc % SOURCE_LENGTHS.length]!), source: `measure:doc-${doc}` });
  }
  return { sources: shape.docs };
}

/** Write every page file, then reconcile the catalog once. */
async function buildPages(root: string, shape: CorpusShape): Promise<Record<string, number>> {
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  for (let doc = 0; doc < shape.docs; doc += 1) await writeFile(path.join(root, "wiki", "concepts", `d${doc}.md`), pageText(doc, shape.chunksPerDoc));
  const wiki = createWikiCore({ root });
  // An incumbent project has no catalog: its listings read the files.
  if (!(await wiki.catalog.status()).active) return { pages: shape.docs };
  return { pages: shape.docs, reprojected: (await wiki.catalog.sync()).reprojected };
}

/** The stored page and chunk vector counts and width, read from the actual store the project serves search from. */
async function storedVectors(root: string): Promise<{ pages: number; chunks: number; dimensions: number }> {
  const { store, warnings } = await loadEmbeddingsForSearch(root);
  if (store === null) throw new Error(`no usable vector store: ${JSON.stringify(warnings)}`);
  if (isShardedView(store)) return { pages: store.meta.pages, chunks: store.meta.chunks, dimensions: store.meta.dimensions };
  return { pages: store.entries.length, chunks: store.chunks?.length ?? 0, dimensions: store.dimensions };
}

/** Embed every page through the routed writer, then prove the stored counts and width. */
async function buildVectors(root: string, shape: CorpusShape): Promise<Record<string, number>> {
  await updateEmbeddings(root, Array.from({ length: shape.docs }, (_, doc) => `concepts/d${doc}` as PageId));
  const stored = await storedVectors(root);
  const expected = { pages: shape.docs, chunks: shape.docs * shape.chunksPerDoc, dimensions: MEASURE_VECTOR_DIMENSIONS };
  if (JSON.stringify(stored) !== JSON.stringify(expected)) throw new Error(`stored vectors ${JSON.stringify(stored)} are not ${JSON.stringify(expected)}`);
  return stored;
}

/** Append `eventsPerDoc` events per document. */
async function buildEvents(root: string, shape: CorpusShape): Promise<Record<string, number>> {
  const total = shape.docs * shape.eventsPerDoc;
  for (let at = 0; at < total; at += 1) await appendEvent(root, { type: "connector-fetch", origin: "measure", payload: { n: at }, at: AT });
  return { events: total };
}

/** Append `relationsPerDoc` relations per document, then one operation-bound relation. */
async function buildRelations(root: string, shape: CorpusShape): Promise<Record<string, number>> {
  for (let doc = 0; doc < shape.docs; doc += 1) {
    for (let n = 0; n < shape.relationsPerDoc; n += 1) await appendRelation(root, MEASURE_PROFILE, relationTo(doc, n));
  }
  await underProjectLock(root, () => appendRelationForOperationLocked(root, MEASURE_PROFILE, relationTo(-1, 0), MEASURE_BINDING));
  return { relations: shape.docs * shape.relationsPerDoc + 1 };
}

/** The operation-catalog record of document `doc`. */
export function opcatRecord(doc: number) {
  return createCatalogRecord({ logicalRecordId: `l-${doc}`, mutationId: `opm_${doc.toString(16).padStart(64, "0")}`, payload: {}, createdAt: AT });
}

/** Append one operation-catalog record per document. */
async function buildOpcat(root: string, shape: CorpusShape): Promise<Record<string, number>> {
  for (let doc = 0; doc < shape.docs; doc += 1) await underProjectLock(root, () => appendCatalogRecordLocked(root, MEASURE_WORKSPACE, opcatRecord(doc)));
  return { records: shape.docs };
}

/** The scale report `init` leaves behind (what {@link indexedInitRefusal} reads). */
type InitScaleReport = Awaited<ReturnType<Awaited<ReturnType<typeof initWikiCore>>["scale"]["status"]>>;
type InitPending = NonNullable<InitScaleReport["record"]>["pending"];
/** Most characters of the parked step's detail kept in the refusal. */
const INIT_REFUSAL_DETAIL_CHARS = 400;

/** The architecture (or "none") and pending transition (or null) of an init report. */
function initState(report: InitScaleReport): { architecture: string; pending: InitPending } {
  return { architecture: report.record?.active.architecture ?? "none", pending: report.record?.pending ?? null };
}

/** The parked step of a pending transition as bounded "; name: detail" text, or "" when none is parked. */
function parkedStepDetail(pending: InitPending): string {
  const parked = pending !== null && "steps" in pending ? pending.steps.find((step) => step.status === "parked") : undefined;
  return parked === undefined ? "" : `; ${parked.name}: ${parked.detail ?? ""}`.slice(0, INIT_REFUSAL_DETAIL_CHARS);
}

/** Whether a transition is pending, with the parked step's bounded detail when there is one. */
function pendingText(pending: InitPending): string {
  return pending === null ? "nothing pending" : `a transition pending${parkedStepDetail(pending)}`;
}

/** Why an init that requested an indexed layout is NOT ready on `local-indexed` with nothing pending, or `undefined` when it is. */
function indexedInitRefusal(report: InitScaleReport): string | undefined {
  const { architecture, pending } = initState(report);
  if (report.readiness === "ready" && architecture === "local-indexed" && pending === null) return undefined;
  return `readiness ${report.readiness}, active ${architecture}, ${pendingText(pending)}`;
}

/**
 * Initialize the project with its expected scale (none when `expectedDocuments` is 0: today's default path). An
 * indexed layout that was REQUESTED must be reached: a parked preparation (for example the free-space preflight)
 * would otherwise let `init` exit cleanly and fail a later child with a pending-transition refusal.
 */
async function buildInit(root: string, shape: CorpusShape): Promise<Record<string, unknown>> {
  const wiki = await initWikiCore(shape.expectedDocuments > 0 ? { root, expectedScale: { documents: shape.expectedDocuments } } : { root });
  if (shape.expectedDocuments === 0) return { expectedDocuments: 0 };
  const refusal = indexedInitRefusal(await wiki.scale.status());
  if (refusal !== undefined) throw new Error(`init did not reach local-indexed for ${shape.expectedDocuments} expected documents: ${refusal}`);
  return { expectedDocuments: shape.expectedDocuments, architecture: "local-indexed" };
}

/** Migrate an incumbent project: set an indexed expected scale, which prepares (imports) and activates. */
async function buildMigrate(root: string): Promise<Record<string, unknown>> {
  const report = await createWikiCore({ root }).scale.set({ documents: MIGRATE_DOCUMENTS });
  const active = report.record?.active.architecture;
  const pending = report.record?.pending ?? null;
  // Only a ready, indexed, nothing-pending record is a completed migration; unavailable, preparing and parked are not.
  if (report.readiness !== "ready" || active !== "local-indexed" || pending !== null) {
    throw new Error(`migration did not complete: ${JSON.stringify({ readiness: report.readiness, active, pending }).slice(0, 500)}`);
  }
  return { readiness: report.readiness, active, pending };
}

/** Compile once with the offline provider. */
async function buildCompile(root: string): Promise<Record<string, unknown>> {
  const result = await createWikiCore({ root }).compile();
  // The offline provider's schema-empty extraction is reported per source as "No concepts extracted"; anything else fails.
  const unexpected = result.errors.filter((error) => !error.startsWith("No concepts extracted from "));
  if (unexpected.length > 0) throw new Error(`compile reported errors: ${unexpected.slice(0, 3).join("; ")}`);
  return { compiled: result.compiled, skipped: result.skipped, emptyExtractions: result.errors.length };
}

/** Source `source-<n>.md` belongs to document `n` (the ingest slug of "Source <n>"). */
const SOURCE_DOC = /^source-(\d+)\.md$/;

/**
 * A DECLARED SYNTHETIC processed-source checkpoint (not proof of an LLM
 * compile): every corpus source is recorded as compiled, through the real
 * state writer (`readState`, `applySourceState`, `applyPromptModifiers`,
 * `writeState`), with its current SHA-256 (`hashFile`), the concept `d<n>`
 * its document's page already holds, a fixed timestamp and the current
 * prompt-modifier digest, so the next real compile has nothing to process.
 */
async function buildNoopCheckpoint(root: string): Promise<Record<string, unknown>> {
  const state = await readState(root);
  let recorded = 0;
  for (const name of await readdir(path.join(root, "sources"))) {
    const doc = SOURCE_DOC.exec(name)?.[1];
    if (doc === undefined) continue;
    applySourceState(state, name, { hash: await hashFile(path.join(root, "sources", name)), concepts: [`d${doc}`], compiledAt: AT });
    recorded += 1;
  }
  await writeState(root, applyPromptModifiers(state, promptModifiersDigest()));
  return { recorded };
}

/** Every build phase by name. */
export const BUILD_PHASES: Record<string, (root: string, shape: CorpusShape) => Promise<Record<string, unknown>>> = {
  init: buildInit, sources: buildSources, pages: buildPages, vectors: buildVectors,
  events: buildEvents, relations: buildRelations, opcat: buildOpcat, compile: (root) => buildCompile(root), migrate: (root) => buildMigrate(root),
  "noop-checkpoint": (root) => buildNoopCheckpoint(root),
};
