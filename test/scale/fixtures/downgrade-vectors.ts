/**
 * @file test/scale/fixtures/downgrade-vectors.ts
 * @description Decode snapshot vectors while preserving absent versus unavailable evidence.
 */

import type { StoredEmbeddingRead } from "../../../src/utils/embeddings-storage.js";

/** Return page vectors, allowing absence only for a layout without a required store. */
export function vectorsFromStoredRead(read: StoredEmbeddingRead, required: boolean): Record<string, number[]> {
  if (read.kind === "unavailable") throw new Error(`embedding store unavailable: ${read.reason}`);
  if (read.kind === "absent") {
    if (required) throw new Error("required embedding store is absent");
    return {};
  }
  const entries = (read.parsed.store as { entries: Array<{ pageId: string; vector: number[] }> }).entries;
  return Object.fromEntries(entries.map((entry) => [entry.pageId, entry.vector]));
}
