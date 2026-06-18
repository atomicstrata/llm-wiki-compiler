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

import { getProvider } from "./provider.js";
import { hashChunkText, splitIntoChunks } from "./retrieval.js";
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

/**
 * Refresh chunk embeddings for the given pages, reusing existing chunk vectors
 * whose contentHash still matches. Pages absent from `records` are pruned.
 */
async function refreshChunkEmbeddings(
  records: PageRecord[],
  existing: ChunkEmbeddingEntry[],
  forceAll: boolean,
): Promise<ChunkEmbeddingEntry[]> {
  const liveSlugs = new Set(records.map((r) => r.slug));
  const existingByKey = indexChunksByKey(existing.filter((c) => liveSlugs.has(c.slug)));
  const now = new Date().toISOString();
  const fresh: ChunkEmbeddingEntry[] = [];

  for (const record of records) {
    const pageChunks = await embedRecordChunks(record, existingByKey, forceAll, now);
    fresh.push(...pageChunks);
  }
  return fresh;
}

/**
 * Embed (or reuse) every chunk for a single page, in order. Reused chunks have
 * their `title` refreshed so a renamed page propagates to the chunk metadata.
 */
async function embedRecordChunks(
  record: PageRecord,
  existingByKey: Map<string, ChunkEmbeddingEntry>,
  forceAll: boolean,
  now: string,
): Promise<ChunkEmbeddingEntry[]> {
  const provider = getProvider();
  const chunkTexts = splitIntoChunks(record.body);
  const out: ChunkEmbeddingEntry[] = [];

  for (let i = 0; i < chunkTexts.length; i++) {
    const text = chunkTexts[i];
    const contentHash = hashChunkText(text);
    const reused = pickReusableChunk(existingByKey, record.slug, i, contentHash, forceAll);
    if (reused) {
      out.push({ ...reused, title: record.title });
      continue;
    }
    const vector = await provider.embed(text);
    out.push({
      slug: record.slug, title: record.title, chunkIndex: i,
      contentHash, text, vector, updatedAt: now,
    });
  }
  return out;
}

/** Index existing chunks by `${slug}#${chunkIndex}` for O(1) reuse lookup. */
function indexChunksByKey(chunks: ChunkEmbeddingEntry[]): Map<string, ChunkEmbeddingEntry> {
  const byKey = new Map<string, ChunkEmbeddingEntry>();
  for (const chunk of chunks) byKey.set(chunkKey(chunk.slug, chunk.chunkIndex), chunk);
  return byKey;
}

/** Compose the index key for a chunk lookup. */
function chunkKey(slug: string, chunkIndex: number): string {
  return `${slug}#${chunkIndex}`;
}

/** Return the existing chunk vector when its hash still matches and reuse is allowed. */
function pickReusableChunk(
  byKey: Map<string, ChunkEmbeddingEntry>,
  slug: string,
  chunkIndex: number,
  contentHash: string,
  forceAll: boolean,
): ChunkEmbeddingEntry | null {
  if (forceAll) return null;
  const existing = byKey.get(chunkKey(slug, chunkIndex));
  if (!existing) return null;
  return existing.contentHash === contentHash ? existing : null;
}

/**
 * Re-embed the given changed slugs and prune any entries whose pages no longer
 * exist on disk. Changed slugs not present as live pages are silently skipped.
 */
export async function updateEmbeddings(root: string, changedSlugs: string[]): Promise<void> {
  const records = await collectPageRecords(root);
  const liveSlugs = new Set(records.map((r) => r.slug));
  const embeddingModel = resolveEmbeddingModel();
  const existingStore = await readEmbeddingStore(root);
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

  const freshEntries = await embedPages(records, toEmbed);
  const mergedEntries = mergeEntries(previousEntries, freshEntries, liveSlugs);
  const mergedChunks = await refreshChunkEmbeddings(records, previousChunks, modelChanged);

  await persistRefreshedStore(root, embeddingModel, mergedEntries, mergedChunks);
}

/** Persist a freshly merged store and emit a friendly status line. */
async function persistRefreshedStore(
  root: string,
  embeddingModel: string,
  entries: EmbeddingEntry[],
  chunks: ChunkEmbeddingEntry[],
): Promise<void> {
  const dimensions = entries[0]?.vector.length ?? chunks[0]?.vector.length ?? 0;
  const store: EmbeddingStore = {
    version: STORE_VERSION,
    model: embeddingModel,
    dimensions,
    entries,
    chunks,
  };
  await writeEmbeddingStore(root, store);
  output.status(
    "*",
    output.dim(`Embeddings updated (${entries.length} pages, ${chunks.length} chunks).`),
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
