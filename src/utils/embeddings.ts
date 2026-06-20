/**
 * Embedding-based semantic search utilities.
 *
 * Maintains a persistent store of page and chunk embeddings in
 * .llmwiki/embeddings.json and provides cosine-similarity retrieval so the
 * query command can narrow hundreds of pages down to a small top-K before
 * calling the selection LLM.
 *
 * The store is additive: successful embedding calls update entries; failures
 * degrade gracefully (caller falls back to full-index selection).
 *
 * The store has two on-disk versions:
 *   - v1: page-level entries only (legacy; still readable).
 *   - v2: page-level entries plus optional chunk-level entries that enable
 *     paragraph-precision retrieval, content-hash-aware incremental updates,
 *     and reranking before final page selection.
 */

import * as output from "./output.js";
import {
  STORE_VERSION,
  type EmbeddingEntry,
  type ChunkEmbeddingEntry,
  type EmbeddingStore,
  readEmbeddingStore,
  writeEmbeddingStore,
  isStoreEmpty,
  resolveEmbeddingModel,
} from "./embeddings-store.js";
import {
  type PageRecord,
  collectPageRecords,
  embedPages,
  mergeEntries,
} from "./embeddings-pages.js";
import { refreshChunkEmbeddings } from "./embeddings-chunks.js";
import { resolveEmbedBatchSize } from "./embeddings-batch.js";
import { getActiveProviderName } from "./provider.js";
import { EmbeddingIntegrityError } from "./embeddings-validate.js";

/**
 * Re-embed the given changed slugs and prune any entries whose pages no longer
 * exist on disk. Changed slugs not present as live pages are silently skipped.
 */
export async function updateEmbeddings(root: string, changedSlugs: string[]): Promise<void> {
  const records = await collectPageRecords(root);
  const liveSlugs = new Set(records.map((r) => r.slug));
  const embeddingModel = resolveEmbeddingModel();
  const existingStore = await readExistingStoreForUpdate(root);
  const modelChanged = Boolean(existingStore && existingStore.model !== embeddingModel);
  const toEmbed = new Set(changedSlugs.filter((slug) => liveSlugs.has(slug)));
  const previousEntries = modelChanged ? [] : existingStore?.entries ?? [];
  const previousChunks = modelChanged ? [] : existingStore?.chunks ?? [];

  // Cold start: embed every page so the store is immediately useful.
  // Also treat an empty on-disk store as a cold start so that a project
  // with no ingested pages yet (or a wiped store) gets populated the next
  // time `compile` runs without needing an explicit slug change.
  const isEmptyStore = isStoreEmpty(existingStore);
  if (!existingStore || modelChanged || (isEmptyStore && liveSlugs.size > 0)) {
    for (const record of records) toEmbed.add(record.slug);
  }

  if (!shouldRunEmbedding(modelChanged, toEmbed, previousEntries, previousChunks, liveSlugs)) {
    return;
  }

  const batchSize = resolveEmbedBatchSize(getActiveProviderName()); // explicit name — no cycle
  const expectedDim =
    !modelChanged && existingStore && existingStore.dimensions > 0
      ? existingStore.dimensions
      : undefined;

  const { entries: freshEntries, requests: pageRequests } =
    await embedPages(records, toEmbed, batchSize, expectedDim);
  const mergedEntries = mergeEntries(previousEntries, freshEntries, liveSlugs);
  const { chunks: mergedChunks, embedded: chunksEmbedded, requests: chunkRequests } =
    await refreshChunkEmbeddings(records, previousChunks, modelChanged, batchSize, expectedDim);

  await persistRefreshedStore(root, embeddingModel, mergedEntries, mergedChunks, {
    pagesEmbedded: freshEntries.length,
    pagesTotal: records.length,
    chunksEmbedded,
    chunksTotal: mergedChunks.length,
    requests: pageRequests + chunkRequests,
  });
}

/** Read the existing store, treating local corruption as a cold rebuild. */
async function readExistingStoreForUpdate(root: string): Promise<EmbeddingStore | null> {
  try {
    return await readEmbeddingStore(root);
  } catch (err) {
    if (!isStoreCorruptionError(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    output.status("!", output.warn(`Embedding store is invalid; rebuilding from live pages (${message}).`));
    return null;
  }
}

/** Store JSON/vector corruption is repairable by rebuilding embeddings. */
function isStoreCorruptionError(err: unknown): boolean {
  return err instanceof EmbeddingIntegrityError || err instanceof SyntaxError;
}

/** Persist a freshly merged store and emit a structured embeddings report. */
async function persistRefreshedStore(
  root: string,
  embeddingModel: string,
  entries: EmbeddingEntry[],
  chunks: ChunkEmbeddingEntry[],
  report: { pagesEmbedded: number; pagesTotal: number; chunksEmbedded: number; chunksTotal: number; requests: number },
): Promise<void> {
  const dimensions = entries[0]?.vector.length ?? chunks[0]?.vector.length ?? 0;
  const store: EmbeddingStore = { version: STORE_VERSION, model: embeddingModel, dimensions, entries, chunks };
  await writeEmbeddingStore(root, store);
  output.status(
    "*",
    output.dim(
      `Embeddings: ${report.pagesEmbedded}/${report.pagesTotal} pages, ` +
      `${report.chunksEmbedded}/${report.chunksTotal} chunks embedded ` +
      `(${report.requests} batched requests).`,
    ),
  );
}

/** Decide whether updateEmbeddings has work to do beyond a no-op. */
function shouldRunEmbedding(
  modelChanged: boolean,
  toEmbed: Set<string>,
  previousEntries: EmbeddingEntry[],
  previousChunks: ChunkEmbeddingEntry[],
  liveSlugs: Set<string>,
): boolean {
  if (modelChanged) return true;
  if (toEmbed.size > 0) return true;
  if (!previousEntries.every((e) => liveSlugs.has(e.slug))) return true;
  if (!previousChunks.every((c) => liveSlugs.has(c.slug))) return true;
  // Cold-start case where we have entries but no chunks yet.
  if (previousEntries.length > 0 && previousChunks.length === 0 && liveSlugs.size > 0) return true;
  return false;
}

// Public surface preserved across the module split. Consumers import these from
// "./embeddings.js" today; keep that contract.
export {
  readEmbeddingStore,
  writeEmbeddingStore,
  resolveEmbeddingModel,
  type EmbeddingEntry,
  type ChunkEmbeddingEntry,
  type EmbeddingStore,
} from "./embeddings-store.js";
export {
  cosineSimilarity,
  findTopK,
  findTopKChunks,
  findRelevantPages,
  findRelevantChunks,
  resetStaleEmbeddingWarnings,
} from "./embeddings-search.js";
// updateEmbeddings is declared locally and exported inline.
