/**
 * Chunk-level embedding with content-hash reuse. Phase 2 replaces the per-page
 * sequential loop with a global flat work-list + slot reconstruction so missing
 * chunks across all pages embed in shared batches while order stays
 * deterministic (page order, then chunkIndex).
 */

import { getProvider } from "./provider.js";
import { hashChunkText, splitIntoChunks } from "./retrieval.js";
import { type ChunkEmbeddingEntry } from "./embeddings-store.js";
import type { PageRecord } from "../pages/read.js";
import { embedWorkItems, makeCountingProvider } from "./embeddings-batch.js";

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
): Promise<{ chunks: ChunkEmbeddingEntry[]; embedded: number; requests: number }> {
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

  const { provider, requestCount } = makeCountingProvider(getProvider());
  const vectors = await embedWorkItems(
    provider, work, (w) => w.text, (i) => work[i]?.slug, "chunk", batchSize, expectedDim,
  );

  const chunks = slots.map((slot) => {
    if (slot.kind === "reused") return slot.entry;
    const w = work[slot.workIndex];
    return {
      slug: w.slug, title: w.title, chunkIndex: w.chunkIndex,
      contentHash: w.contentHash, text: w.text, vector: vectors[slot.workIndex], updatedAt: now,
    };
  });
  return { chunks, embedded: work.length, requests: requestCount() };
}

/**
 * Index existing chunks by a structured nested map: page key → chunkIndex → entry.
 *
 * A nested `Map<string, Map<number, ChunkEmbeddingEntry>>` is used instead of the
 * old `${slug}#${chunkIndex}` string key so that a page whose slug or future pageId
 * contains `#` cannot collide with the delimiter. Chunk identity is always the pair
 * `(page key, chunkIndex)` — never a delimited string.
 */
function indexChunksByKey(chunks: ChunkEmbeddingEntry[]): Map<string, Map<number, ChunkEmbeddingEntry>> {
  const byKey = new Map<string, Map<number, ChunkEmbeddingEntry>>();
  for (const chunk of chunks) {
    let inner = byKey.get(chunk.slug);
    if (!inner) { inner = new Map(); byKey.set(chunk.slug, inner); }
    inner.set(chunk.chunkIndex, chunk);
  }
  return byKey;
}

/** Return the existing chunk vector when its hash still matches and reuse is allowed. */
function pickReusableChunk(
  byKey: Map<string, Map<number, ChunkEmbeddingEntry>>,
  slug: string,
  chunkIndex: number,
  contentHash: string,
  forceAll: boolean,
): ChunkEmbeddingEntry | null {
  if (forceAll) return null;
  const existing = byKey.get(slug)?.get(chunkIndex);
  if (!existing) return null;
  return existing.contentHash === contentHash ? existing : null;
}
