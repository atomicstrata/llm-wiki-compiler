/**
 * Chunk-level embedding helpers.
 *
 * Handles embedding (or reusing) paragraph-level chunks for a page, plus the
 * index-key and content-hash-aware reuse lookup utilities shared by both the
 * sequential and batched update pipelines.
 */

import { getProvider } from "./provider.js";
import { hashChunkText, splitIntoChunks } from "./retrieval.js";
import type { ChunkEmbeddingEntry } from "./embeddings.js";
import type { PageRecord } from "../pages/read.js";

/**
 * Refresh chunk embeddings for the given pages, reusing existing chunk vectors
 * whose contentHash still matches. Pages absent from `records` are pruned.
 */
export async function refreshChunkEmbeddings(
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
export function indexChunksByKey(chunks: ChunkEmbeddingEntry[]): Map<string, ChunkEmbeddingEntry> {
  const byKey = new Map<string, ChunkEmbeddingEntry>();
  for (const chunk of chunks) byKey.set(chunkKey(chunk.slug, chunk.chunkIndex), chunk);
  return byKey;
}

/** Compose the index key for a chunk lookup. */
export function chunkKey(slug: string, chunkIndex: number): string {
  return `${slug}#${chunkIndex}`;
}

/** Return the existing chunk vector when its hash still matches and reuse is allowed. */
export function pickReusableChunk(
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
