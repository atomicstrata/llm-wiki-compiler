/**
 * Embedding store shape and persistence.
 *
 * Owns the on-disk JSON contract for .llmwiki/embeddings.json (types, version,
 * atomic read/write) and the active-model resolution used to tag and validate
 * a store. No retrieval or embedding logic lives here — this is the base module
 * every other embeddings-* module depends on, and it depends on none of them.
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { getActiveProviderName } from "./provider.js";
import { atomicWrite } from "./markdown.js";
import { EMBEDDINGS_FILE, EMBEDDING_MODELS } from "./constants.js";

/** Current store version; bumped from 1 → 2 when chunk entries were added. */
export const STORE_VERSION = 2 as const;

/** A single embedded page record. */
export interface EmbeddingEntry {
  slug: string;
  title: string;
  summary: string;
  vector: number[];
  updatedAt: string;
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
}

/** Read .llmwiki/embeddings.json, returning null if it does not exist. */
export async function readEmbeddingStore(root: string): Promise<EmbeddingStore | null> {
  const filePath = path.join(root, EMBEDDINGS_FILE);
  if (!existsSync(filePath)) return null;
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw) as EmbeddingStore;
}

/** Atomically persist the embedding store. */
export async function writeEmbeddingStore(root: string, store: EmbeddingStore): Promise<void> {
  const filePath = path.join(root, EMBEDDINGS_FILE);
  await atomicWrite(filePath, JSON.stringify(store, null, 2));
}

/** Return true when a store exists on disk but has neither page nor chunk entries. */
export function isStoreEmpty(store: EmbeddingStore | null): boolean {
  if (!store) return false;
  return store.entries.length === 0 && (!store.chunks || store.chunks.length === 0);
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
