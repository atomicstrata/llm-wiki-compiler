/**
 * Batched variant of the embedding update pipeline.
 *
 * Unlike the default {@link updateEmbeddings} which embeds pages one at a time
 * and persists only at the end, this version batches multiple texts per API
 * call and writes the store after each batch so an interrupted run can resume.
 */

import { getProvider } from "./provider.js";
import type { LLMProvider } from "./provider.js";
import { EMBEDDING_BATCH_SIZE, EMBEDDING_CHUNK_BATCH_SIZE } from "./constants.js";
import { hashChunkText, splitIntoChunks } from "./retrieval.js";
import {
  type EmbeddingEntry,
  type ChunkEmbeddingEntry,
  type EmbeddingStore,
  type PageRecord,
  STORE_VERSION,
  writeEmbeddingStore,
  resolveEmbeddingState,
  buildEmbeddingText,
  hashPageText,
  mergeEntries,
  isStoreEmpty,
  shouldRunEmbedding,
} from "./embeddings.js";
import { indexChunksByKey, chunkKey, pickReusableChunk } from "./embeddings-chunks.js";
import * as output from "./output.js";

function batchSize(): number {
  const fromEnv = Number(process.env.LLMWIKI_EMBEDDING_BATCH_SIZE);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : EMBEDDING_BATCH_SIZE;
}

function chunkBatchSize(): number {
  const fromEnv = Number(process.env.LLMWIKI_CHUNK_BATCH_SIZE);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : EMBEDDING_CHUNK_BATCH_SIZE;
}

/**
 * Call provider.embedBatch when available, falling back to sequential embed()
 * calls so providers that only implement the single-text method are supported.
 */
async function safeEmbedBatch(provider: LLMProvider, texts: string[]): Promise<number[][]> {
  if (provider.embedBatch) {
    return provider.embedBatch(texts);
  }
  const out: number[][] = [];
  for (const text of texts) out.push(await provider.embed(text));
  return out;
}

/**
 * Determine which slugs to embed based on changed slugs, cold starts, model
 * changes, and interrupted-run resume detection.
 */
function collectSlugsToEmbed(
  records: PageRecord[],
  changedSlugs: string[],
  liveSlugs: Set<string>,
  existingStore: EmbeddingStore | null,
  modelChanged: boolean,
  previousEntries: EmbeddingEntry[],
): Set<string> {
  const toEmbed = new Set(changedSlugs.filter((slug) => liveSlugs.has(slug)));

  const emptyStore = !existingStore || isStoreEmpty(existingStore);
  if (!existingStore || modelChanged || (emptyStore && liveSlugs.size > 0)) {
    for (const record of records) toEmbed.add(record.slug);
  }

  addMissingFromResume(toEmbed, records, previousEntries);
  return toEmbed;
}

/** Add slugs whose pages were never embedded (interrupted-run recovery). */
function addMissingFromResume(
  toEmbed: Set<string>,
  records: PageRecord[],
  previousEntries: EmbeddingEntry[],
): void {
  if (toEmbed.size >= records.length) return;
  const embeddedSlugs = new Set(previousEntries.map((e) => e.slug));
  for (const record of records) {
    if (!embeddedSlugs.has(record.slug)) toEmbed.add(record.slug);
  }
}

/**
 * Embed pages in batches, writing the store after each batch so an
 * interrupted run can resume from the last persisted batch.
 */
async function embedPagesInBatches(
  pagesToEmbed: PageRecord[],
  previousEntries: EmbeddingEntry[],
  previousChunks: ChunkEmbeddingEntry[],
  liveSlugs: Set<string>,
  provider: LLMProvider,
  now: string,
  bs: number,
  embeddingModel: string,
  root: string,
): Promise<EmbeddingEntry[]> {
  const freshEntries: EmbeddingEntry[] = [];
  for (let i = 0; i < pagesToEmbed.length; i += bs) {
    const batch = pagesToEmbed.slice(i, i + bs);
    const vectors = await safeEmbedBatch(provider, batch.map((r) => buildEmbeddingText(r)));

    for (let j = 0; j < batch.length; j++) {
      const record = batch[j];
      freshEntries.push({
        slug: record.slug,
        title: record.title,
        summary: record.summary,
        vector: vectors[j],
        contentHash: hashPageText(record),
        updatedAt: now,
      });
    }

    output.status("*", output.dim(`${Math.min(i + bs, pagesToEmbed.length)}/${pagesToEmbed.length} pages`));
    const merged = mergeEntries(previousEntries, freshEntries, liveSlugs);
    await writeIncrementalStore(root, embeddingModel, merged, previousChunks);
  }
  return freshEntries;
}

/**
 * Collect all chunks across all pages, batch-embed them, and write the
 * store after each batch. Chunks whose contentHash matches an existing
 * entry are reused without an API call.
 */
async function collectAndEmbedChunks(
  records: PageRecord[],
  previousChunks: ChunkEmbeddingEntry[],
  liveSlugs: Set<string>,
  modelChanged: boolean,
  provider: LLMProvider,
  now: string,
  bs: number,
  embeddingModel: string,
  root: string,
  entries: EmbeddingEntry[],
): Promise<void> {
  const existingByKey = indexChunksByKey(previousChunks.filter((c) => liveSlugs.has(c.slug)));

  type ChunkToEmbed = { record: PageRecord; chunkIndex: number; text: string; contentHash: string };
  const chunksToEmbed: ChunkToEmbed[] = [];
  const validKeys = new Set<string>();

  for (const record of records) {
    const chunkTexts = splitIntoChunks(record.body);
    for (let i = 0; i < chunkTexts.length; i++) {
      const text = chunkTexts[i];
      const h = hashChunkText(text);
      const key = chunkKey(record.slug, i);
      validKeys.add(key);
      const reused = pickReusableChunk(existingByKey, record.slug, i, h, modelChanged);
      if (reused) {
        existingByKey.set(key, { ...reused, title: record.title });
      } else {
        chunksToEmbed.push({ record, chunkIndex: i, text, contentHash: h });
      }
    }
  }

  const pagesWithNewChunks = new Set<string>();
  for (let i = 0; i < chunksToEmbed.length; i += bs) {
    const batch = chunksToEmbed.slice(i, i + bs);
    const vectors = await safeEmbedBatch(provider, batch.map((b) => b.text));

    for (let j = 0; j < batch.length; j++) {
      const { record, chunkIndex, text, contentHash } = batch[j];
      const entry: ChunkEmbeddingEntry = {
        slug: record.slug,
        title: record.title,
        chunkIndex,
        contentHash,
        text,
        vector: vectors[j],
        updatedAt: now,
      };
      existingByKey.set(chunkKey(record.slug, chunkIndex), entry);
      pagesWithNewChunks.add(record.slug);
    }

    output.status("*", output.dim(`chunks: ${Math.min(i + bs, chunksToEmbed.length)}/${chunksToEmbed.length} across ${records.length} pages`));
    const chunks = Array.from(existingByKey.values());
    await writeIncrementalStore(root, embeddingModel, entries, chunks);
  }

  for (const key of existingByKey.keys()) {
    if (!validKeys.has(key)) existingByKey.delete(key);
  }

  const chunks = Array.from(existingByKey.values());
  output.status("*", output.dim(`Embeddings updated (${entries.length} pages, ${chunks.length} chunks across ${pagesWithNewChunks.size} pages).`));
  await writeIncrementalStore(root, embeddingModel, entries, chunks);
}

/**
 * Re-embed changed slugs with batched API calls and incremental disk writes.
 * Interrupted runs can resume: pages whose contentHash matches the on-disk
 * entry are skipped on re-run.
 */
export async function updateEmbeddingsBatched(root: string, changedSlugs: string[]): Promise<void> {
  const { records, liveSlugs, embeddingModel, existingStore, modelChanged, previousEntries, previousChunks } = await resolveEmbeddingState(root);
  const toEmbed = collectSlugsToEmbed(records, changedSlugs, liveSlugs, existingStore, modelChanged, previousEntries);

  if (!modelChanged && toEmbed.size === 0 && shouldRunEmbedding(modelChanged, toEmbed, previousEntries, previousChunks, liveSlugs) === false) {
    output.status("*", output.dim("Embeddings up to date."));
    return;
  }

  const provider = getProvider();
  const now = new Date().toISOString();
  const bs = batchSize();

  const previousBySlug = new Map<string, EmbeddingEntry>();
  for (const e of previousEntries) previousBySlug.set(e.slug, e);

  const pagesToEmbed = records.filter((r) => {
    if (!toEmbed.has(r.slug)) return false;
    const existing = previousBySlug.get(r.slug);
    if (existing && existing.contentHash === hashPageText(r)) return false;
    return true;
  });

  const skipped = toEmbed.size - pagesToEmbed.length;
  output.status("*", output.dim(`Embedding ${pagesToEmbed.length} pages in batches of ${bs}${skipped > 0 ? ` (${skipped} skipped — unchanged)` : ""}.`));

  const freshEntries = await embedPagesInBatches(pagesToEmbed, previousEntries, previousChunks, liveSlugs, provider, now, bs, embeddingModel, root);
  const entries = mergeEntries(previousEntries, freshEntries, liveSlugs);
  await collectAndEmbedChunks(records, previousChunks, liveSlugs, modelChanged, provider, now, chunkBatchSize(), embeddingModel, root, entries);
}

/** Write the store mid-batch for incremental progress. */
async function writeIncrementalStore(
  root: string,
  model: string,
  entries: EmbeddingEntry[],
  chunks: ChunkEmbeddingEntry[],
): Promise<void> {
  const dimensions = entries[0]?.vector.length ?? chunks[0]?.vector.length ?? 0;
  const store: EmbeddingStore = {
    version: STORE_VERSION,
    model,
    dimensions,
    entries,
    chunks,
  };
  await writeEmbeddingStore(root, store);
}

