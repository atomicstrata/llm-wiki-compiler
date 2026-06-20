/**
 * Embedding-based retrieval: cosine similarity ranking and top-K lookup over a
 * loaded store. Read-side only — never writes the store or calls the embedding
 * pipeline beyond embedding the live query string.
 */

import { getProvider } from "./provider.js";
import { EMBEDDING_TOP_K } from "./constants.js";
import * as output from "./output.js";
import {
  type EmbeddingEntry,
  type ChunkEmbeddingEntry,
  type EmbeddingStore,
  readEmbeddingStore,
  resolveEmbeddingModel,
} from "./embeddings-store.js";
import { EmbeddingIntegrityError, assertVectorValid } from "./embeddings-validate.js";

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

/**
 * Embed the question, look up top-K matches, and return lightweight page records.
 * Returns [] when no store exists so callers can transparently fall back.
 */
export async function findRelevantPages(
  root: string,
  question: string,
): Promise<Array<{ slug: string; title: string; summary: string }>> {
  const store = await loadActiveStore(root, (s) => s.entries.length > 0);
  if (!store) return [];

  const queryVec = await getProvider().embed(question, "query");
  assertVectorValid(queryVec, store.dimensions);
  return findTopK(queryVec, store, EMBEDDING_TOP_K).map((entry) => ({
    slug: entry.slug,
    title: entry.title,
    summary: entry.summary,
  }));
}

/**
 * Look up top-K chunks similar to the question. Returns [] when no chunk-level
 * store exists so callers can fall back to page-level retrieval.
 */
export async function findRelevantChunks(
  root: string,
  question: string,
  k: number,
): Promise<Array<{ chunk: ChunkEmbeddingEntry; score: number }>> {
  const store = await loadActiveStore(root, (s) => Boolean(s.chunks && s.chunks.length > 0));
  if (!store) return [];
  const queryVec = await getProvider().embed(question, "query");
  assertVectorValid(queryVec, store.dimensions);
  return findTopKChunks(queryVec, store.chunks ?? [], k);
}

/**
 * Read the embedding store, returning null when it is missing, empty (per the
 * caller's predicate), or built with a stale model. Centralises the "is this
 * store usable for semantic lookup right now?" check.
 */
async function loadActiveStore(
  root: string,
  hasContent: (store: EmbeddingStore) => boolean,
): Promise<EmbeddingStore | null> {
  const store = await readActiveStore(root);
  if (!store || !hasContent(store)) return null;
  const activeModel = resolveEmbeddingModel();
  if (store.model !== activeModel) {
    warnStaleEmbeddingStore(store.model, activeModel);
    return null;
  }
  return store;
}

/** Read a store for retrieval; invalid local state behaves like no store. */
async function readActiveStore(root: string): Promise<EmbeddingStore | null> {
  try {
    return await readEmbeddingStore(root);
  } catch (err) {
    if (!(err instanceof EmbeddingIntegrityError)) throw err;
    warnInvalidEmbeddingStore(err);
    return null;
  }
}

/** Warn once for invalid embedding state so repeated queries stay readable. */
function warnInvalidEmbeddingStore(err: Error): void {
  const key = `invalid:${err.message}`;
  if (warnedStaleModels.has(key)) return;
  warnedStaleModels.add(key);
  output.status("!", output.warn(`Embedding store is invalid; semantic lookup skipped (${err.message}).`));
}

/** Tracks which (stored, active) model pairs have already been warned about. */
const warnedStaleModels = new Set<string>();

/** Warn once per (stored, active) model pair so queries stay quiet on repeat runs. */
function warnStaleEmbeddingStore(storedModel: string, activeModel: string): void {
  const key = `${storedModel}→${activeModel}`;
  if (warnedStaleModels.has(key)) return;
  warnedStaleModels.add(key);
  output.status(
    "!",
    output.warn(
      `Embedding store was built with "${storedModel}" but active embedding model is "${activeModel}". ` +
      `Falling back to full-index selection. Run 'llmwiki compile' to rebuild embeddings.`,
    ),
  );
}

/** Test-only hook: clear the warned-pair cache so each test sees a fresh warning. */
export function resetStaleEmbeddingWarnings(): void {
  warnedStaleModels.clear();
}
