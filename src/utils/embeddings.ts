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

import { readFile, readdir, writeFile, rename, rm } from "fs/promises";
import { existsSync } from "fs";
import { createHash } from "crypto";
import path from "path";
import { getProvider, getActiveProviderName } from "./provider.js";
import { atomicWrite, safeReadFile, parseFrontmatter } from "./markdown.js";
import {
  CONCEPTS_DIR,
  QUERIES_DIR,
  EMBEDDINGS_FILE,
  EMBEDDINGS_BIN_FILE,
  EMBEDDING_TOP_K,
  EMBEDDING_MODELS,
} from "./constants.js";
import { serializeBinaryStore, deserializeBinaryStore } from "./embeddings-binary.js";
import { findTopK, findTopKChunks } from "./embeddings-similarity.js";
import { refreshChunkEmbeddings } from "./embeddings-chunks.js";
import type { PageRecord } from "../pages/read.js";
import * as output from "./output.js";

export { cosineSimilarity, findTopK, findTopKChunks } from "./embeddings-similarity.js";

/** Current store version; bumped from 1 → 2 when chunk entries were added. */
export const STORE_VERSION = 2 as const;

/** A single embedded page record. */
export interface EmbeddingEntry {
  slug: string;
  title: string;
  summary: string;
  vector: number[];
  updatedAt: string;
  /** SHA256 hex (first 16 chars) of buildEmbeddingText output; absent in stores built by older versions. */
  contentHash?: string;
}

/** A single embedded chunk drawn from a page body. */
export interface ChunkEmbeddingEntry {
  slug: string;
  title: string;
  chunkIndex: number;
  contentHash: string;
  text: string;
  vector: number[];
  updatedAt: string;
}

/** Root shape of .llmwiki/embeddings.json. */
export interface EmbeddingStore {
  version: 1 | 2;
  model: string;
  dimensions: number;
  entries: EmbeddingEntry[];
  /** Optional in v2 stores; absent in v1 stores. */
  chunks?: ChunkEmbeddingEntry[];
  /** When true, vectors are stored in .llmwiki/embeddings.bin instead of JSON. */
  binaryVectors?: boolean;
}

export type { PageRecord };

/** Read .llmwiki/embeddings.json, returning null if it does not exist. */
export async function readEmbeddingStore(root: string): Promise<EmbeddingStore | null> {
  const filePath = path.join(root, EMBEDDINGS_FILE);
  if (!existsSync(filePath)) return null;
  const raw = await readFile(filePath, "utf-8");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store: any = JSON.parse(raw);
  if (store.binaryVectors) {
    const binPath = path.join(root, EMBEDDINGS_BIN_FILE);
    if (!existsSync(binPath)) return null;
    const binBuffer = await readFile(binPath);
    return deserializeBinaryStore(store, binBuffer);
  }
  return store as EmbeddingStore;
}

/** Atomically persist the embedding store. */
export async function writeEmbeddingStore(root: string, store: EmbeddingStore): Promise<void> {
  const filePath = path.join(root, EMBEDDINGS_FILE);
  if (process.env.LLMWIKI_BINARY_EMBEDDINGS === "true") {
    const binPath = path.join(root, EMBEDDINGS_BIN_FILE);
    const serialized = serializeBinaryStore(store);
    await atomicWrite(filePath, JSON.stringify(serialized.store, null, 2));
    const tmpBinPath = binPath + ".tmp";
    await writeFile(tmpBinPath, serialized.buffer);
    await rename(tmpBinPath, binPath);
  } else {
    await atomicWrite(filePath, JSON.stringify(store, null, 2));
    const binPath = path.join(root, EMBEDDINGS_BIN_FILE);
    await rm(binPath, { force: true });
  }
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

  const queryVec = await getProvider().embed(question);
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
  const queryVec = await getProvider().embed(question);
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
  const store = await readEmbeddingStore(root);
  if (!store || !hasContent(store)) return null;
  const activeModel = resolveEmbeddingModel();
  if (store.model !== activeModel) {
    warnStaleEmbeddingStore(store.model, activeModel);
    return null;
  }
  return store;
}

/** Scan concepts/ and queries/ directories, returning retrievable pages. */
async function collectPageRecords(root: string): Promise<PageRecord[]> {
  const records: PageRecord[] = [];
  for (const dir of [CONCEPTS_DIR, QUERIES_DIR]) {
    const absDir = path.join(root, dir);
    let files: string[];
    try {
      files = await readdir(absDir);
    } catch {
      continue;
    }
    for (const file of files.filter((f) => f.endsWith(".md"))) {
      const record = await readPageRecord(absDir, file);
      if (record) records.push(record);
    }
  }
  return records;
}

/** Parse a single page file into a PageRecord, skipping orphans/untitled pages. */
async function readPageRecord(absDir: string, file: string): Promise<PageRecord | null> {
  const content = await safeReadFile(path.join(absDir, file));
  const { meta, body } = parseFrontmatter(content);
  if (meta.orphaned || typeof meta.title !== "string") return null;
  return {
    slug: file.replace(/\.md$/, ""),
    title: meta.title,
    summary: typeof meta.summary === "string" ? meta.summary : "",
    body,
  };
}

/** Build the text that represents a page in the embedding space. */
export function buildEmbeddingText(record: PageRecord): string {
  return record.summary
    ? `${record.title}\n\n${record.summary}`
    : record.title;
}

/** Produce a short content hash for embedding text so callers can detect staleness. */
function hashEmbeddingText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Hash the text used for page-level embeddings. */
export function hashPageText(record: PageRecord): string {
  return hashEmbeddingText(buildEmbeddingText(record));
}


/**
 * Embed every page in `records` whose slug appears in `slugsToEmbed`,
 * returning the new entries. Failures bubble up to the caller.
 */
async function embedPages(
  records: PageRecord[],
  slugsToEmbed: Set<string>,
): Promise<EmbeddingEntry[]> {
  const provider = getProvider();
  const now = new Date().toISOString();
  const fresh: EmbeddingEntry[] = [];

  for (const record of records) {
    if (!slugsToEmbed.has(record.slug)) continue;
    const vector = await provider.embed(buildEmbeddingText(record));
    fresh.push({
      slug: record.slug,
      title: record.title,
      summary: record.summary,
      vector,
      contentHash: hashPageText(record),
      updatedAt: now,
    });
  }
  return fresh;
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

/** Choose the active embedding model name, defaulting to anthropic's voyage model. */
export function resolveEmbeddingModel(): string {
  const providerName = getActiveProviderName();
  const configuredModel = process.env.LLMWIKI_EMBEDDING_MODEL?.trim();
  if (configuredModel && (providerName === "openai" || providerName === "ollama")) {
    return configuredModel;
  }
  return EMBEDDING_MODELS[providerName] ?? EMBEDDING_MODELS.anthropic;
}

/** Merge fresh embeddings into an existing store, dropping slugs not in liveSlugs. */
export function mergeEntries(
  existing: EmbeddingEntry[],
  fresh: EmbeddingEntry[],
  liveSlugs: Set<string>,
): EmbeddingEntry[] {
  const bySlug = new Map<string, EmbeddingEntry>();
  for (const entry of existing) {
    if (liveSlugs.has(entry.slug)) bySlug.set(entry.slug, entry);
  }
  for (const entry of fresh) {
    bySlug.set(entry.slug, entry);
  }
  return Array.from(bySlug.values());
}

/** Shared state loaded by both updateEmbeddings variants. */
interface EmbeddingState {
  records: PageRecord[];
  liveSlugs: Set<string>;
  embeddingModel: string;
  existingStore: EmbeddingStore | null;
  modelChanged: boolean;
  previousEntries: EmbeddingEntry[];
  previousChunks: ChunkEmbeddingEntry[];
}

export async function resolveEmbeddingState(root: string): Promise<EmbeddingState> {
  const records = await collectPageRecords(root);
  const liveSlugs = new Set(records.map((r) => r.slug));
  const embeddingModel = resolveEmbeddingModel();
  const existingStore = await readEmbeddingStore(root);
  const modelChanged = Boolean(existingStore && existingStore.model !== embeddingModel);
  return {
    records,
    liveSlugs,
    embeddingModel,
    existingStore,
    modelChanged,
    previousEntries: modelChanged ? [] : existingStore?.entries ?? [],
    previousChunks: modelChanged ? [] : existingStore?.chunks ?? [],
  };
}

/**
 * Re-embed the given changed slugs and prune any entries whose pages no longer
 * exist on disk. Changed slugs not present as live pages are silently skipped.
 */
export async function updateEmbeddings(root: string, changedSlugs: string[]): Promise<void> {
  const { records, liveSlugs, embeddingModel, existingStore, modelChanged, previousEntries, previousChunks } = await resolveEmbeddingState(root);

  const toEmbed = new Set(changedSlugs.filter((slug) => liveSlugs.has(slug)));

  // Cold start: embed every page so the store is immediately useful.
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

/** Return true when a store exists on disk but has neither page nor chunk entries. */
export function isStoreEmpty(store: EmbeddingStore | null): boolean {
  if (!store) return false;
  return store.entries.length === 0 && (!store.chunks || store.chunks.length === 0);
}

/** Decide whether updateEmbeddings has work to do beyond a no-op. */
export function shouldRunEmbedding(
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
