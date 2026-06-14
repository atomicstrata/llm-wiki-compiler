/**
 * Cosine similarity and top-K ranking helpers for embedding vectors.
 *
 * Pure functions with zero dependencies on the store I/O layer, so they can be
 * imported by embeddings.ts without creating a circular dependency.
 */

import type { EmbeddingStore, EmbeddingEntry, ChunkEmbeddingEntry } from "./embeddings.js";

/**
 * Cosine similarity between two equal-length vectors.
 * Returns 0 when either vector has zero magnitude (safer than NaN for ranking).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/** Return the top-K entries most similar to the query vector, sorted descending. */
export function findTopK(
  queryVec: number[],
  store: EmbeddingStore,
  k: number,
): EmbeddingEntry[] {
  const scored = store.entries.map((entry) => ({
    entry,
    score: cosineSimilarity(queryVec, entry.vector),
  }));
  scored.sort((left, right) => right.score - left.score);
  return scored.slice(0, k).map((item) => item.entry);
}

/** Score and sort chunk entries by cosine similarity, returning the top-K. */
export function findTopKChunks(
  queryVec: number[],
  chunks: ChunkEmbeddingEntry[],
  k: number,
): Array<{ chunk: ChunkEmbeddingEntry; score: number }> {
  const scored = chunks.map((chunk) => ({
    chunk,
    score: cosineSimilarity(queryVec, chunk.vector),
  }));
  scored.sort((left, right) => right.score - left.score);
  return scored.slice(0, k);
}
