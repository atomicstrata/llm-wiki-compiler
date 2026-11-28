/**
 * @file test/scale-measure/ops.ts
 * @description The measured operations, each run in a fresh child (a cold
 * pass, then a warm pass in the same process) through the ordinary routes a
 * project serves them by. `narrow` operations are the ones whose work must
 * not grow with the corpus; `global` ones are explicit O(N) work, measured
 * and reported as such (full verification, materializers, status, sync after
 * a change, a no-op compile, a vector refresh's incumbent live-page
 * collection). Each returns a small summary proving it did the work.
 */

import { readFileSync } from "node:fs";
import { appendFile, mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { openCatalog } from "../../src/catalog/meta.js";
import { lookupSourceIdentity } from "../../src/catalog/reads.js";
import { appendEvent } from "../../src/events/store.js";
import { findEventsByMutation, readEventsPage, verifyEventHistory } from "../../src/history/events-read.js";
import { readyEventLogMeta, openEventLog } from "../../src/history/events-log.js";
import { catalogRecordByMutation, openOperationCatalog } from "../../src/history/operation-catalog.js";
import { appendCatalogRecordLocked } from "../../src/operation-bundles/catalog-store.js";
import { appendRelation, updateRelation } from "../../src/relations/store.js";
import { readRelations } from "../../src/relations/store-read.js";
import { createWikiCore } from "../../src/sdk/core.js";
import { loadSourceSelection } from "../../src/sources/selection.js";
import { findRelevantChunksV3, findRelevantPagesV3, loadEmbeddingsForSearch } from "../../src/utils/embeddings-load.js";
import { updateEmbeddings } from "../../src/utils/embeddings.js";
import type { PageId } from "../../src/utils/page-id.js";
import { MEASURE_BINDING, MEASURE_PROFILE, MEASURE_WORKSPACE, opcatRecord, pageText, relationTo, underProjectLock, type CorpusShape } from "./corpus.js";

/** One measured operation. */
interface MeasuredOp {
  readonly kind: "narrow" | "global";
  run(root: string, shape: CorpusShape, pass: number): Promise<Record<string, unknown>>;
}

const QUESTION = "lorem ipsum document seven";
/** Page size of the listing witnesses. */
const PAGE_LIMIT = 50;
const CALIBRATION_BYTES = 32;
const AT = "2026-10-26T00:00:00.000Z";

/** The middle document of the corpus. */
const middle = (shape: CorpusShape) => Math.floor(shape.docs / 2);

/** First page of pages, then the next one by cursor. */
async function listPagesTwice(root: string, shape: CorpusShape): Promise<Record<string, unknown>> {
  const wiki = createWikiCore({ root });
  const first = await wiki.listPages({ limit: PAGE_LIMIT });
  mustHold(first.pages.length === Math.min(shape.docs, PAGE_LIMIT), "page listing did not return seeded pages", first.pages.length);
  if (shape.docs <= PAGE_LIMIT) return { first: first.pages.length, next: 0, catalog: (first as { catalog?: unknown }).catalog };
  mustHold(typeof first.cursor === "string" && first.cursor.length > 0, "page listing did not return a cursor", first.cursor);
  const next = await wiki.listPages({ limit: PAGE_LIMIT, cursor: first.cursor });
  mustHold(next.pages.length === Math.min(shape.docs - PAGE_LIMIT, PAGE_LIMIT), "page listing second page was short", next.pages.length);
  return { first: first.pages.length, next: next.pages.length, catalog: (first as { catalog?: unknown }).catalog };
}

/** First page of sources. */
async function listSourcesOnce(root: string, shape: CorpusShape): Promise<Record<string, unknown>> {
  const listed = await createWikiCore({ root }).listSources({ limit: 50 });
  mustHold(listed.sources.length === Math.min(shape.docs, 50), "source listing did not return seeded sources", listed.sources.length);
  return { sources: listed.sources.length, catalog: (listed as { catalog?: unknown }).catalog };
}

/** Full status must still contain the seeded corpus after measured mutations. */
async function statusSnapshot(root: string, shape: CorpusShape): Promise<Record<string, unknown>> {
  const status = await createWikiCore({ root }).status();
  mustHold(Number.isSafeInteger(status.sources) && Number.isSafeInteger(status.pages?.total)
    && status.sources >= shape.docs && status.pages.total >= shape.docs,
  "status did not include seeded corpus", { sources: status.sources, pages: status.pages?.total });
  return { sources: status.sources, pages: status.pages.total };
}

/** One identity lookup of the middle source. */
async function identityLookup(root: string, shape: CorpusShape): Promise<Record<string, unknown>> {
  const id = await lookupSourceIdentity(root, await openCatalog(root), await loadSourceSelection(root), `measure:doc-${middle(shape)}`);
  mustHold(id === `source-${middle(shape)}.md`, "source identity lookup returned no seeded source", id);
  return { found: id };
}

/** Ingest one new source. */
async function ingestOne(root: string, _shape: CorpusShape, pass: number): Promise<Record<string, unknown>> {
  const result = await createWikiCore({ root }).ingestText({ title: `Extra ${pass} ${Date.now()}`, text: "extra ".repeat(200), source: `measure:extra-${pass}-${Date.now()}` });
  return { ingested: Boolean(result) };
}

/** Edit one page externally, then reconcile (explicit full walk). */
async function syncAfterEdit(root: string, shape: CorpusShape, pass: number): Promise<Record<string, unknown>> {
  await appendFile(path.join(root, "wiki", "concepts", `d${middle(shape)}.md`), `\nEdited ${pass}.\n`);
  return { ...(await createWikiCore({ root }).catalog.sync()) };
}

/** Append one event. */
async function eventAppend(root: string, _shape: CorpusShape, pass: number): Promise<Record<string, unknown>> {
  const record = await appendEvent(root, { type: "connector-fetch", origin: "measure-op", payload: { pass }, at: AT });
  return { id: record.id };
}

/** One page of 100 events from the middle of the log. */
async function eventPage(root: string): Promise<Record<string, unknown>> {
  const count = readyEventLogMeta(await openEventLog(root)).count;
  const page = await readEventsPage(root, Math.floor(count / 2), 100);
  return { count, read: page.events.length };
}

/** A relation append: a new one, or (`dedupe`) an exact live duplicate. */
function relationAppend(dedupe: boolean): MeasuredOp["run"] {
  return async (root, shape, pass) => {
    const ref = await appendRelation(root, MEASURE_PROFILE, dedupe ? relationTo(middle(shape), 0) : relationTo(1_000_000 + pass, Date.now() % 1000));
    return { id: ref.id };
  };
}

/** Update the middle document's first relation by id (latest-by-id lookup plus append). */
async function relationUpdate(root: string, shape: CorpusShape, pass: number): Promise<Record<string, unknown>> {
  const ref = await appendRelation(root, MEASURE_PROFILE, relationTo(middle(shape), 0));
  const updated = await updateRelation(root, MEASURE_PROFILE, ref.id, { attributes: { pass } } as never);
  return { id: updated.id };
}

/** Throw unless `condition` holds: a semantic failure fails the child, never a silent number. */
function mustHold(condition: boolean, failure: string, detail?: unknown): void {
  if (!condition) throw new Error(`${failure}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 500)}`}`);
}

/** Top-10 exact vector search over pages and chunks; a degraded store or a short result fails. */
async function vectorSearch(root: string, shape: CorpusShape): Promise<Record<string, unknown>> {
  const { store, warnings } = await loadEmbeddingsForSearch(root);
  mustHold(store !== null && warnings.length === 0, "semantic search is degraded", warnings);
  const pages = await findRelevantPagesV3(root, store!, "search", QUESTION, 10);
  const chunks = await findRelevantChunksV3(root, store!, "search", QUESTION, 10);
  const want = Math.min(10, shape.docs);
  mustHold(pages.hits.length === want && chunks.hits.length === Math.min(10, shape.docs * shape.chunksPerDoc), "semantic search returned too few hits", { pages: pages.hits.length, chunks: chunks.hits.length });
  return { pages: pages.hits.length, chunks: chunks.hits.length };
}

/** A full verification that must pass; its bounded result (counts, the storage inventory, the sampled stores) is kept whole. */
async function verified(work: Promise<{ ok: boolean }>, failure: string): Promise<Record<string, unknown>> {
  const report = await work;
  mustHold(report.ok, failure, report);
  return { ...report };
}

/**
 * An offline compile of the unchanged corpus (run before any operation
 * mutates it): a DISTINCT, degraded-extraction workload. The compiler never
 * records a source whose extraction is empty and the offline provider's
 * extractions are schema-empty, so every source is re-extracted in process
 * each time. It must process exactly the corpus's sources and report nothing
 * but empty extractions. It is NOT a no-op compile (see `compile-noop`).
 */
async function compileOffline(root: string, shape: CorpusShape): Promise<Record<string, unknown>> {
  const result = await createWikiCore({ root }).compile();
  const unexpected = result.errors.filter((error) => !error.startsWith("No concepts extracted from "));
  mustHold(result.compiled === shape.docs && result.deleted === 0 && unexpected.length === 0, "the offline compile did not process exactly the corpus", result);
  return { compiled: result.compiled, skipped: result.skipped, emptyExtractions: result.errors.length };
}

/**
 * A real SDK compile after the synthetic processed-source checkpoint
 * (`noop-checkpoint`, a separate child): it must find nothing to do, so its
 * cost is the no-op compile's global work (every source hashed, state and
 * index read and written).
 */
async function compileNoop(root: string, shape: CorpusShape): Promise<Record<string, unknown>> {
  const result = await createWikiCore({ root }).compile();
  mustHold(result.compiled === 0 && result.skipped === shape.docs && result.deleted === 0 && result.errors.length === 0, "compile was not a no-op", result);
  return { compiled: result.compiled, skipped: result.skipped };
}

/** Write and read 32-byte fixtures through every instrumented fs entry point (area `other`), for calibration. */
async function fsCalibration(root: string): Promise<Record<string, unknown>> {
  const dir = path.join(root, ".calibration");
  await mkdir(dir, { recursive: true });
  const bytes = Buffer.alloc(CALIBRATION_BYTES, 7);
  await writeFile(path.join(dir, "a"), bytes);
  const handle = await open(path.join(dir, "b"), "w");
  await handle.writeFile(bytes);
  await handle.write(bytes, 0, CALIBRATION_BYTES, CALIBRATION_BYTES);
  await handle.close();
  const reader = await open(path.join(dir, "b"), "r");
  await reader.read(Buffer.alloc(CALIBRATION_BYTES), 0, CALIBRATION_BYTES, 0);
  await reader.readFile();
  await reader.close();
  await readFile(path.join(dir, "a"));
  readFileSync(path.join(dir, "a"));
  return { expected: { opens: 2, bytesWritten: 3 * CALIBRATION_BYTES, bytesRead: 5 * CALIBRATION_BYTES } };
}

/** Change one page's summary, then refresh embeddings for it. */
async function vectorUpdateOne(root: string, shape: CorpusShape, pass: number): Promise<Record<string, unknown>> {
  const file = path.join(root, "wiki", "concepts", `d${middle(shape)}.md`);
  const chunks = (await readFile(file, "utf8")).split("\n\n").length - 1;
  await writeFile(file, pageText(middle(shape), chunks, `Changed summary ${pass} ${Date.now()}`));
  await updateEmbeddings(root, [`concepts/d${middle(shape)}` as PageId]);
  return { page: `concepts/d${middle(shape)}` };
}

/** Append one operation-catalog record, then look one up by mutation. */
async function opcatAppendLookup(root: string, shape: CorpusShape, pass: number): Promise<Record<string, unknown>> {
  const outcome = await underProjectLock(root, () => appendCatalogRecordLocked(root, MEASURE_WORKSPACE, opcatRecord(10_000_000 + pass + (Date.now() % 1_000_000) * 10)));
  const seed = opcatRecord(middle(shape));
  const found = await catalogRecordByMutation(await openOperationCatalog(root, MEASURE_WORKSPACE), seed.mutationId);
  mustHold(found?.mutationId === seed.mutationId, "operation catalog lookup returned no seeded record", found);
  return { outcome, found: true };
}

/** The seeded operation relation's bound audit event, which must be unique. */
async function boundEventLookup(root: string): Promise<Record<string, unknown>> {
  const found = await findEventsByMutation(root, MEASURE_BINDING.mutationId);
  mustHold(found.length === 1, "bound event lookup returned no seeded event", found.length);
  return { found: found.length };
}

/** Every measured operation by name. */
export const MEASURED_OPS: Record<string, MeasuredOp> = {
  "compile-offline": { kind: "global", run: compileOffline },
  "compile-noop": { kind: "global", run: compileNoop },
  "fs-calibration": { kind: "global", run: (root) => fsCalibration(root) },
  "list-pages": { kind: "narrow", run: listPagesTwice },
  "list-sources": { kind: "narrow", run: listSourcesOnce },
  "catalog-status": { kind: "narrow", run: async (root) => {
    const status = await createWikiCore({ root }).catalog.status();
    mustHold(status.active, "the catalog is not active", status);
    return { ...status };
  } },
  "identity-lookup": { kind: "narrow", run: identityLookup },
  "ingest-one": { kind: "narrow", run: ingestOne },
  "event-append": { kind: "narrow", run: eventAppend },
  "event-page": { kind: "narrow", run: (root) => eventPage(root) },
  "event-find-mutation": { kind: "narrow", run: (root) => boundEventLookup(root) },
  "relation-append-new": { kind: "narrow", run: relationAppend(false) },
  "relation-append-dedupe": { kind: "narrow", run: relationAppend(true) },
  "relation-update": { kind: "narrow", run: relationUpdate },
  "opcat-append-lookup": { kind: "narrow", run: opcatAppendLookup },
  "vector-search": { kind: "global", run: (root, shape) => vectorSearch(root, shape) },
  "vector-update-one": { kind: "global", run: vectorUpdateOne },
  "sync-after-edit": { kind: "global", run: syncAfterEdit },
  "event-verify-full": { kind: "global", run: (root) => verified(verifyEventHistory(root), "event history verification failed") },
  "relations-materialize": { kind: "global", run: async (root) => ({ relations: (await readRelations(root)).relations.length }) },
  "status": { kind: "global", run: statusSnapshot },
  "verify-all": { kind: "global", run: (root) => verified(createWikiCore({ root }).catalog.verify(), "full verification failed") },
};
