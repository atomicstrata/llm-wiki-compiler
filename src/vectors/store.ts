/**
 * @file src/vectors/store.ts
 * @description Opening the piecewise vector store, its strict facts, and the
 * search VIEW the incumbent read pipeline is handed instead of a whole
 * materialized store on a `local-indexed` project.
 *
 * The view carries no vectors: it names the store and its facts, and the
 * search functions stream rows from it with a bounded resident set. Gating is
 * the incumbent's: a store built by a different embedding configuration, or
 * an empty one, degrades with the same warnings; a corrupt or unfinished one
 * degrades as unavailable (no backup fallback), and a fault met while a
 * search streams rows rejects into the caller's existing embedding-failure
 * policy.
 */

import { indexedActive } from "../indexed/routing.js";
import { hasExactKeys, isCount, isLegacySnapshot } from "../history/contracts.js";
import { corrupt, IndexedStoreError } from "../segments/contracts.js";
import type { IoCounters } from "../segments/counters.js";
import { diskSegmentStoreIo } from "../segments/io.js";
import { SegmentStore } from "../segments/store.js";
import { EMBEDDINGS_BINARY_FILE, EMBEDDINGS_FILE } from "../utils/constants.js";
import { storeMatchesActiveEmbedding } from "../utils/embedding-identity.js";
import { MAX_DIMENSIONS } from "./codec.js";
import { VECTOR_SEGMENT_BYTES, VECTORS_STORE, type VectorMeta } from "./contracts.js";

/** What the incumbent find functions are handed for a `local-indexed` project. */
export interface ShardedVectorView {
  readonly kind: "sharded";
  readonly store: SegmentStore;
  readonly meta: VectorMeta;
  /** When set, only these page ids are eligible (a caller's page scope). */
  readonly scope?: ReadonlySet<string>;
}

/** Whether `value` is a sharded view (rather than a materialized store). */
export function isShardedView(value: unknown): value is ShardedVectorView {
  return value !== null && typeof value === "object" && (value as { kind?: unknown }).kind === "sharded";
}

/** Open the vector store of `root`. */
export function openVectorStore(root: string, counters?: IoCounters): Promise<SegmentStore> {
  return SegmentStore.open(diskSegmentStoreIo(root, VECTORS_STORE), { segmentBytes: VECTOR_SEGMENT_BYTES, ...(counters === undefined ? {} : { counters }) });
}

/** Whether `value` is a string or null. */
function stringOrNull(value: unknown): boolean {
  return value === null || typeof value === "string";
}

/** The validated (closed) facts of an opened vector store. */
export function vectorMetaOf(store: SegmentStore): VectorMeta {
  const meta: unknown = store.meta;
  // The closed shape is checked BEFORE any field is read, so a null or non-object meta is corruption, never a TypeError.
  if (!store.exists || !hasExactKeys(meta, ["schema", "phase", "model", "fingerprint", "dimensions", "pages", "chunks", "legacy"])) corrupt("the vector store manifest is missing or malformed");
  const valid = meta.schema === 1 && (meta.phase === "importing" || meta.phase === "ready" || meta.phase === "rebuilding")
    && stringOrNull(meta.model) && stringOrNull(meta.fingerprint) && countsValid(meta) && legacyValid(meta.legacy);
  if (!valid) corrupt("the vector store manifest is missing or malformed");
  return meta as unknown as VectorMeta;
}

/** Whether the width and counts are in domain and agree with each other (a non-empty store names its model and, unless rebuilding, its width). */
function countsValid(meta: Record<string, unknown>): boolean {
  if (!countsInDomain(meta)) return false;
  const empty = meta.pages === 0 && meta.chunks === 0;
  return (meta.model !== null || empty) && (empty || meta.phase === "rebuilding" || (meta.dimensions as number) > 0);
}

/** Whether the width and both counts are non-negative integers, the width within `MAX_DIMENSIONS`. */
function countsInDomain(meta: Record<string, unknown>): boolean {
  return isCount(meta.dimensions) && (meta.dimensions as number) <= MAX_DIMENSIONS && isCount(meta.pages) && isCount(meta.chunks);
}

/** Whether the backup snapshot is well formed and names one of the incumbent embedding files. */
function legacyValid(legacy: unknown): boolean {
  const legacyPath = hasExactKeys(legacy, ["relPath", "stamp", "records", "bytes", "sha256"]) ? legacy.relPath : undefined;
  return (legacyPath === EMBEDDINGS_FILE || legacyPath === EMBEDDINGS_BINARY_FILE) && isLegacySnapshot(legacy, legacyPath);
}

/** The facts of a store active readers and writers may use: well formed and fully imported (a rebuild may be under way). */
export function readyVectorMeta(store: SegmentStore): VectorMeta {
  const meta = vectorMetaOf(store);
  if (meta.phase === "importing") corrupt("the vector store has not finished importing");
  return meta;
}

/** The incumbent degraded outcome shape. */
type Degraded = { store: null; warnings: Array<{ code: "embedding-index-outdated" | "embedding-store-unavailable"; message: string }>; stalePageIds: [] };

/** A degraded outcome with one warning. */
function degradedOutcome(code: Degraded["warnings"][number]["code"], message: string): Degraded {
  return { store: null, warnings: [{ code, message }], stalePageIds: [] };
}

/** The opened store and its ready facts, or the store fault that keeps them from being used. */
async function openReadyVectors(root: string): Promise<{ store: SegmentStore; meta: VectorMeta } | IndexedStoreError> {
  try {
    const store = await openVectorStore(root);
    return { store, meta: readyVectorMeta(store) };
  } catch (error) {
    if (error instanceof IndexedStoreError) return error;
    throw error;
  }
}

/**
 * The search view of `root` when it is `local-indexed` (gated like the
 * incumbent store), a degraded outcome, or `null` elsewhere. An unreadable
 * SCALE authority still refuses (thrown by the route); a vector-store fault
 * (corrupt, unavailable or unfinished) degrades with the incumbent
 * `embedding-store-unavailable` warning, exactly as an unreadable incumbent
 * file does, and never falls back to the retained backup.
 */
export async function shardedSearchOutcome(root: string): Promise<{ store: ShardedVectorView; warnings: []; stalePageIds: [] } | Degraded | null> {
  if (!(await indexedActive(root))) return null;
  const opened = await openReadyVectors(root);
  if (opened instanceof IndexedStoreError) return degradedOutcome("embedding-store-unavailable", `The local-indexed vector store cannot be used (${opened.message}); semantic retrieval is unavailable until it is repaired.`);
  const { store, meta } = opened;
  const degraded = (message: string): Degraded => degradedOutcome("embedding-index-outdated", message);
  if (meta.pages === 0 && meta.chunks === 0) return degraded("No embedding index found.");
  if (meta.phase === "rebuilding") return degraded("Embedding index is being rebuilt for a new embedding configuration; finish it with 'llmwiki compile'.");
  let current = false;
  try { current = storeMatchesActiveEmbedding({ model: meta.model, ...(meta.fingerprint === null ? {} : { fingerprint: meta.fingerprint }) }); } catch { current = false; }
  if (!current) return degraded("Embedding index was built with a different embedding configuration; rebuild with 'llmwiki compile'.");
  return { store: { kind: "sharded", store, meta }, warnings: [], stalePageIds: [] };
}

/** The page and chunk counts of `root`'s vector store when it is `local-indexed`, else `null`. */
export async function shardedCounts(root: string): Promise<{ pages: number; chunks: number } | null> {
  if (!(await indexedActive(root))) return null;
  const meta = readyVectorMeta(await openVectorStore(root));
  return { pages: meta.pages, chunks: meta.chunks };
}
