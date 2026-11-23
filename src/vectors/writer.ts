/**
 * @file src/vectors/writer.ts
 * @description The embedding refresh of a `local-indexed` project: the
 * incumbent writer core's contract (what is re-embedded, what is kept, what
 * is pruned, what is reported) over the piecewise vector store.
 *
 * CHANGE DETECTION reads only the light `m:` metadata rows (text hash, chunk
 * hashes and the configuration each page's vectors came from), never the
 * vectors; it holds those small rows for the pages of the project, the same
 * global collection a refresh already makes of the live pages. Re-embedding
 * uses the incumbent batched passes. WRITES touch only the rows of
 * re-embedded or removed pages, in bounded batches of pages, each batch one
 * conditional commit, so a refresh never rewrites the corpus; merges of those
 * batches retain their inputs (disk growth is reported, not reclaimed).
 *
 * A NEW EMBEDDING CONFIGURATION (the incumbent predicate decides) is a
 * REBUILD: the first commit marks the store `rebuilding` with the new
 * identity and no inherited dimension, so readers degrade instead of mixing
 * identities; every page whose vectors came from another configuration is
 * re-embedded or, if deferred, removed (as the incumbent migration does not
 * preserve them); the last commit marks it `ready`. An interrupted rebuild
 * stays `rebuilding` and the next refresh resumes it page by page. A batch
 * approval (`affected-only`) refuses a rebuild, before any provider call.
 * Pending and quarantine markers stay with the caller; a failure part-way
 * reports nothing persisted, so retries remain owed.
 */

import type { EmbeddingAttemptRecorder } from "../utils/embedding-attempts.js";
import { collectEligibleLivePagesFrom, contentHashesOf, requestedPagesExistenceFrom, type CollectedPage } from "../utils/embeddings-collect.js";
import { FullEmbeddingReconciliationRequiredError, type EmbeddingPrepare, type ScopedEmbeddingSources } from "../utils/embeddings-scoped.js";
import { resolveEmbeddingFingerprint, resolveEmbeddingModel, storeMatchesActiveEmbedding } from "../utils/embedding-identity.js";
import type { ChunkEmbeddingV3, PageEmbeddingV3 } from "../utils/embeddings-store.js";
import { embedTargets } from "../utils/embeddings-write.js";
import { resolveEmbedBatchSize } from "../utils/embeddings-batch.js";
import { getActiveEmbeddingProviderName } from "../utils/embedding-provider.js";
import type { PageId } from "../utils/page-id.js";
import { loadProfileFrom } from "../profile/load.js";
import { sortedByKey, type SegmentRow } from "../segments/contracts.js";
import type { SegmentStore } from "../segments/store.js";
import { asPageMetaRow, encodeVector } from "./codec.js";
import { chunkVectorKey, pageMetaKey, pageVectorKey, type PageMetaRow, type VectorMeta } from "./contracts.js";
import { openVectorStore, readyVectorMeta } from "./store.js";

/** Pages re-embedded and committed per bounded batch. */
const PAGES_PER_COMMIT = 128;

/** What one refresh reports (the incumbent core's result). */
export interface ShardedRefreshResult { embedded: PageId[]; eligible: PageId[]; pruned: PageId[] }

/** Whether facts carrying `model`/`fingerprint` were produced by the ACTIVE configuration (the incumbent predicate). */
function current(model: string | null, fingerprint: string | null): boolean {
  if (model === null) return true;
  try { return storeMatchesActiveEmbedding({ model, ...(fingerprint === null ? {} : { fingerprint }) }); } catch { return false; }
}

/** The stored change-detection facts of every page (metadata rows only; no vectors). */
async function storedMeta(store: SegmentStore): Promise<Map<PageId, PageMetaRow>> {
  const meta = new Map<PageId, PageMetaRow>();
  for await (const row of store.scan({ prefix: "m:" })) meta.set(row.k.slice(2) as PageId, asPageMetaRow(row.v));
  return meta;
}

/** Whether a collected page needs new vectors: changed content, or vectors from another configuration. */
function needsEmbedding(page: CollectedPage, stored: PageMetaRow | undefined): boolean {
  return stored === undefined || !current(stored.model, stored.fingerprint) || stored.embeddingTextHash !== page.embeddingTextHash
    || stored.chunkHashes.length !== page.chunkContentHashes.length || stored.chunkHashes.some((hash, at) => hash !== page.chunkContentHashes[at]);
}

/** Tombstones for every stored row of `pageId`. */
function removalRows(pageId: PageId, stored: PageMetaRow): SegmentRow[] {
  return [
    { k: pageVectorKey(pageId), d: 1 }, { k: pageMetaKey(pageId), d: 1 },
    ...stored.chunkHashes.map((_hash, at): SegmentRow => ({ k: chunkVectorKey(pageId, at), d: 1 })),
  ];
}

/** The rows that store one re-embedded page, dropping chunk rows past its new chunk count. */
function pageRows(entry: PageEmbeddingV3, chunks: readonly ChunkEmbeddingV3[], stored: PageMetaRow | undefined): SegmentRow[] {
  const { vector, ...page } = entry;
  const rows: SegmentRow[] = [{ k: pageVectorKey(entry.pageId), v: { ...page, vec: encodeVector(vector) } }];
  for (const chunk of chunks) {
    const { vector: chunkVector, ...rest } = chunk;
    rows.push({ k: chunkVectorKey(chunk.pageId, chunk.chunkIndex), v: { ...rest, vec: encodeVector(chunkVector) } });
  }
  for (let at = chunks.length; at < (stored?.chunkHashes.length ?? 0); at += 1) rows.push({ k: chunkVectorKey(entry.pageId, at), d: 1 });
  const meta: PageMetaRow = { embeddingTextHash: entry.embeddingTextHash, chunkHashes: chunks.map((chunk) => chunk.contentHash), model: resolveEmbeddingModel(), fingerprint: resolveEmbeddingFingerprint() };
  rows.push({ k: pageMetaKey(entry.pageId), v: meta });
  return rows;
}

/** The plan of one refresh. */
interface RefreshPlan { collected: CollectedPage[]; eligible: PageId[]; reembed: Set<PageId>; remove: PageId[]; stored: Map<PageId, PageMetaRow> }

/** Decide one refresh. `affected` restricts it to those ids (the batch-approval scope). */
async function plan(sources: ScopedEmbeddingSources, store: SegmentStore, changedIds: PageId[], prepare: EmbeddingPrepare | undefined, affected: Set<PageId> | null): Promise<RefreshPlan> {
  const profile = await loadProfileFrom(sources.profile);
  const all = await collectEligibleLivePagesFrom(sources.live, profile);
  const collected = affected === null ? all : all.filter((page) => affected.has(page.pageId));
  const eligible = collected.map((page) => page.pageId);
  const stored = await storedMeta(store);
  const wanted = new Set(changedIds);
  const discovered = collected.filter((page) => affected !== null || wanted.has(page.pageId) || needsEmbedding(page, stored.get(page.pageId))).map((page) => page.pageId);
  const reembed = new Set(prepare ? await prepare(discovered, contentHashesOf(collected)) : discovered);
  const eligibleSet = new Set(eligible);
  const scope = affected ?? new Set(stored.keys());
  const remove = [...stored.keys()].filter((id) => scope.has(id) && !reembed.has(id)
    && (!eligibleSet.has(id) || !current(stored.get(id)!.model, stored.get(id)!.fingerprint)));
  return { collected, eligible, reembed, remove, stored };
}

/** Whether coherent stored metadata names a page vector; chunk-only imports use an empty text hash. */
function hasPageVector(stored: PageMetaRow | undefined): boolean {
  return stored !== undefined && stored.embeddingTextHash !== "";
}

/** The counts after `pageEntries`/`chunkEntries` replace their stored versions. */
function countsAfter(facts: VectorMeta, refresh: RefreshPlan, pageEntries: PageEmbeddingV3[], chunkEntries: ChunkEmbeddingV3[]): Pick<VectorMeta, "pages" | "chunks"> {
  const added = pageEntries.filter((entry) => !hasPageVector(refresh.stored.get(entry.pageId))).length;
  const replacedChunks = pageEntries.reduce((sum, entry) => sum + (refresh.stored.get(entry.pageId)?.chunkHashes.length ?? 0), 0);
  return { pages: facts.pages + added, chunks: facts.chunks + chunkEntries.length - replacedChunks };
}

/** Embed and commit `targets` in bounded batches. */
async function embedInBatches(store: SegmentStore, meta: VectorMeta, refresh: RefreshPlan, targets: CollectedPage[], recorder?: EmbeddingAttemptRecorder): Promise<{ store: SegmentStore; meta: VectorMeta }> {
  let current = store;
  let facts = meta;
  const batchSize = resolveEmbedBatchSize(getActiveEmbeddingProviderName());
  for (let start = 0; start < targets.length; start += PAGES_PER_COMMIT) {
    const { pageEntries, chunkEntries } = await embedTargets(targets.slice(start, start + PAGES_PER_COMMIT), batchSize, facts.dimensions > 0 ? facts.dimensions : undefined, recorder);
    const byPage = new Map<PageId, ChunkEmbeddingV3[]>();
    for (const chunk of chunkEntries) byPage.set(chunk.pageId, [...(byPage.get(chunk.pageId) ?? []), chunk]);
    const rows = pageEntries.flatMap((entry) => pageRows(entry, byPage.get(entry.pageId) ?? [], refresh.stored.get(entry.pageId)));
    const dimensions = pageEntries[0]?.vector.length ?? chunkEntries[0]?.vector.length ?? facts.dimensions;
    facts = { ...facts, dimensions, ...countsAfter(facts, refresh, pageEntries, chunkEntries) };
    current = await current.commit({ rows: sortedByKey(rows), meta: { ...facts } });
  }
  return { store: current, meta: facts };
}

/** Commit the removals of `ids` (possibly none) and the final phase in one batch. */
async function commitRemovals(store: SegmentStore, meta: VectorMeta, stored: Map<PageId, PageMetaRow>, ids: PageId[]): Promise<void> {
  if (ids.length === 0 && meta.phase === "ready") return;
  const rows = ids.flatMap((id) => removalRows(id, stored.get(id)!));
  const chunks = ids.reduce((sum, id) => sum + stored.get(id)!.chunkHashes.length, 0);
  const pages = ids.filter((id) => hasPageVector(stored.get(id))).length;
  await store.commit({ rows: sortedByKey(rows), meta: { ...meta, phase: "ready", pages: meta.pages - pages, chunks: meta.chunks - chunks } });
}

/** Mark a rebuild for a new configuration before any page is written; returns the snapshot and facts to continue with. */
async function beginRebuild(store: SegmentStore, meta: VectorMeta): Promise<{ store: SegmentStore; meta: VectorMeta }> {
  const facts: VectorMeta = { ...meta, phase: "rebuilding", model: resolveEmbeddingModel(), fingerprint: resolveEmbeddingFingerprint(), dimensions: 0 };
  return { store: await store.commit({ meta: { ...facts } }), meta: facts };
}

/** Refresh the vectors of `root` like the incumbent locked core. The caller holds the project lock. */
export async function refreshShardedEmbeddings(
  root: string, sources: ScopedEmbeddingSources, changedIds: PageId[], prepare?: EmbeddingPrepare, affectedOnly = false, recorder?: EmbeddingAttemptRecorder,
): Promise<ShardedRefreshResult> {
  let store = await openVectorStore(root);
  let meta = readyVectorMeta(store);
  // A store imported from NO incumbent embeddings has no configuration yet: its first write stamps the active one.
  if (meta.model === null) meta = { ...meta, model: resolveEmbeddingModel(), fingerprint: resolveEmbeddingFingerprint() };
  const rebuild = meta.phase === "rebuilding" || !current(meta.model, meta.fingerprint);
  if (rebuild && affectedOnly) throw new FullEmbeddingReconciliationRequiredError("backend");
  const refresh = await plan(sources, store, changedIds, prepare, affectedOnly ? new Set(changedIds) : null);
  if (rebuild && meta.phase !== "rebuilding") ({ store, meta } = await beginRebuild(store, meta));
  const targets = refresh.collected.filter((page) => refresh.reembed.has(page.pageId));
  const written = await embedInBatches(store, meta, refresh, targets, recorder);
  await commitRemovals(written.store, written.meta, refresh.stored, refresh.remove);
  if (targets.length > 0) recorder?.markPersisted();
  const existence = await requestedPagesExistenceFrom(sources.live.pages, await loadProfileFrom(sources.profile), changedIds);
  const kept = new Set(refresh.eligible);
  return { embedded: [...refresh.reembed], eligible: refresh.eligible, pruned: changedIds.filter((id) => existence.get(id) === "absent" && !kept.has(id)) };
}
