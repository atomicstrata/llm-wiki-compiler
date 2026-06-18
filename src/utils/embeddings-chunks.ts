/**
 * Chunk-level embedding with content-hash reuse. Phase 2 replaces the per-page
 * sequential loop with a global flat work-list + slot reconstruction so missing
 * chunks across all pages embed in shared batches while order stays
 * deterministic (page order, then chunkIndex).
 */

import { getProvider } from "./provider.js";
import { hashChunkText, splitIntoChunks } from "./retrieval.js";
import { type ChunkEmbeddingEntry } from "./embeddings-store.js";
import { type PageRecord } from "./embeddings-pages.js";
import { embedTextBatch, enrichEmbedError } from "./embeddings-batch.js";

/** One output position: a reused entry, or a pending one awaiting a fresh vector. */
type ChunkSlot =
  | { kind: "reused"; entry: ChunkEmbeddingEntry }
  | { kind: "pending"; workIndex: number };

interface ChunkWorkItem {
  text: string;
  slug: string;
  title: string;
  chunkIndex: number;
  contentHash: string;
}

/**
 * Refresh chunk embeddings for all live pages. Build ordered slots (page order,
 * then chunkIndex), reuse unchanged chunks by hash, batch only the missing ones
 * across all pages, then reconstruct from slots so order never depends on the
 * provider response order.
 */
export async function refreshChunkEmbeddings(
  records: PageRecord[],
  existing: ChunkEmbeddingEntry[],
  forceAll: boolean,
  batchSize: number,
  expectedDim?: number,
): Promise<{ chunks: ChunkEmbeddingEntry[]; embedded: number }> {
  const liveSlugs = new Set(records.map((r) => r.slug));
  const existingByKey = indexChunksByKey(existing.filter((c) => liveSlugs.has(c.slug)));
  const now = new Date().toISOString();

  const slots: ChunkSlot[] = [];
  const work: ChunkWorkItem[] = [];

  for (const record of records) {
    const texts = splitIntoChunks(record.body);
    for (let i = 0; i < texts.length; i++) {
      const contentHash = hashChunkText(texts[i]);
      const reused = pickReusableChunk(existingByKey, record.slug, i, contentHash, forceAll);
      if (reused) {
        slots.push({ kind: "reused", entry: { ...reused, title: record.title } });
      } else {
        slots.push({ kind: "pending", workIndex: work.length });
        work.push({ text: texts[i], slug: record.slug, title: record.title, chunkIndex: i, contentHash });
      }
    }
  }

  const provider = getProvider();
  let vectors: number[][];
  try {
    vectors = await embedTextBatch(provider, work.map((w) => w.text), batchSize, expectedDim);
  } catch (err) {
    throw enrichEmbedError(err, "chunk", (i) => work[i]?.slug);
  }

  const chunks = slots.map((slot) => {
    if (slot.kind === "reused") return slot.entry;
    const w = work[slot.workIndex];
    return {
      slug: w.slug, title: w.title, chunkIndex: w.chunkIndex,
      contentHash: w.contentHash, text: w.text, vector: vectors[slot.workIndex], updatedAt: now,
    };
  });
  return { chunks, embedded: work.length };
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
