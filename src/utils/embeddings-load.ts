/**
 * Degrade-aware v3 read pipeline (PR4D Task D3, spec §4.6/§4.7/§4.8).
 *
 * The surface loaders return an {@link EmbeddingLoadOutcome} — never a bare
 * store-or-null — so a consumer ALWAYS sees WHY semantic retrieval contributed
 * nothing (a v2/older store is degraded-on-read with a structured
 * `embedding-index-outdated` warning; lexical retrieval still works).
 *
 * READ-ONLY invariant: this module NEVER writes, migrates, or prunes the store.
 * Stale (not-live / hash-mismatched) ids are reported in `stalePageIds`; the
 * actual pruning happens only on the next write (D7).
 *
 * The retrieval pipeline (§4.6 steps 3-5):
 *   3. cheap identity prefilter — drop store entries whose `pageId` is not a
 *      live page (`buildLiveIdSet`) and whose surface flag excludes it, BEFORE
 *      any scoring;
 *   4. score the survivors in memory (cosine);
 *   5. walk the ranked candidates filling results — per candidate (score order)
 *      resolve via the live registry + verify content freshness, keep a fresh
 *      hit, drop+warn a stale one, stop at K fresh hits or pool exhaustion. This
 *      prevents a stale high-score hit from crowding out a lower-score fresh one.
 *
 * S12 rehydration: output `title`/`summary`/`text` come from the LIVE file (via
 * the registry loaders), never the store's cached copies — the cached values
 * exist only for migration/reuse and are NOT a tamper boundary (S8).
 */

import { getProvider } from "./provider.js";
import { assertVectorValid } from "./embeddings-validate.js";
import {
  parseEmbeddingStore,
  validateV3ForSearch,
  resolveEmbeddingModel,
  readConfinedRaw,
  type EmbeddingStoreV3,
  type PageEmbeddingV3,
  type ChunkEmbeddingV3,
} from "./embeddings-store.js";
import { cosineSimilarity } from "./embeddings-search.js";
import {
  buildLiveIdSet,
  buildLiveRegistryEntry,
  loadPageRecordsByPageId,
  buildNamespaceDirs,
  type LiveRegistryEntry,
} from "./page-registry.js";
import { splitIntoChunks } from "./retrieval.js";
import { parseQualifiedPageId, type PageId } from "./page-id.js";
import type { LoadedProfile } from "../profile/types.js";
import type { PageRecord } from "../pages/read.js";

/** Namespace→directory map resolved from the active profile (or reserved-only). */
type NamespaceDirs = Map<string, string>;

/** Which surface flag a load filters by (each surface filters independently). */
export type RetrievalSurface = "search" | "context";

/** Structured warning surfaced in the outcome the consumer actually reads (S6). */
export interface EmbeddingWarning {
  code:
    | "embedding-index-outdated"
    | "embedding-store-unavailable"
    | "embedding-entry-stale";
  message: string;
}

/**
 * Outcome of a surface load. `store` is non-null only for a fully-handled v3
 * store; a v2/older/failed-gate/corrupt store degrades to `null` + a warning.
 */
export interface EmbeddingLoadOutcome {
  store: EmbeddingStoreV3 | null;
  warnings: EmbeddingWarning[];
  stalePageIds: PageId[];
}

/** A live-rehydrated page hit carrying its qualified id (spec §4.7). */
export interface PageHitV3 {
  pageId: PageId;
  slug: string;
  title: string;
  summary: string;
  score: number;
}

/** A live-rehydrated chunk hit carrying its qualified id and chunk index. */
export interface ChunkHitV3 {
  pageId: PageId;
  slug: string;
  chunkIndex: number;
  contentHash: string;
  text: string;
  score: number;
}

/**
 * Load the active store for the SEARCH surface. The returned store is filtered
 * by `includeInSearch` later, in {@link findRelevantPagesV3}/{@link findRelevantChunksV3}
 * — the load itself only version/integrity/model-gates (degrade-on-read).
 */
export async function loadEmbeddingsForSearch(root: string): Promise<EmbeddingLoadOutcome> {
  return gateActiveStore(root);
}

/**
 * Load the active store for the CONTEXT surface. Filtering by `includeInContext`
 * happens in the pipeline functions; the load is surface-agnostic gating only.
 */
export async function loadEmbeddingsForContext(root: string): Promise<EmbeddingLoadOutcome> {
  return gateActiveStore(root);
}

/**
 * Parse + gate the on-disk store READ-ONLY. Returns a usable v3 store, or a
 * degraded outcome (`store: null`) with a structured warning when the store is
 * not v3 (older version — the writer has not flipped yet), failed the search
 * gate (corrupt vectors / over-cap), is stale-model, or is absent.
 */
async function gateActiveStore(root: string): Promise<EmbeddingLoadOutcome> {
  const raw = await readConfinedRaw(root);
  if (raw === null) return degraded("embedding-index-outdated", "No embedding index found.");
  const parsed = parseStoreRaw(raw);
  if (!parsed || parsed.version !== 3) {
    return degraded("embedding-index-outdated", "Embedding index is an older version; rebuild with 'llmwiki compile'.");
  }
  const validation = validateV3ForSearch(parsed);
  if (!validation.available) {
    return degraded("embedding-store-unavailable", "Embedding index failed integrity validation; rebuilt on next compile.");
  }
  if (isStaleModel(parsed.store)) {
    return degraded("embedding-index-outdated", "Embedding index was built with a different model; rebuild with 'llmwiki compile'.");
  }
  return { store: parsed.store as unknown as EmbeddingStoreV3, warnings: [], stalePageIds: [] };
}

/** Parse raw JSON into a discriminated store, swallowing JSON errors as degrade. */
function parseStoreRaw(raw: string): ReturnType<typeof parseEmbeddingStore> {
  try {
    return parseEmbeddingStore(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

/** True when the persisted store's model differs from the active model. */
function isStaleModel(store: Record<string, unknown>): boolean {
  try {
    return store.model !== resolveEmbeddingModel();
  } catch {
    return true;
  }
}

/** Build a degraded (store-null) outcome with one structured warning. */
function degraded(code: EmbeddingWarning["code"], message: string): EmbeddingLoadOutcome {
  return { store: null, warnings: [{ code, message }], stalePageIds: [] };
}

/**
 * Run the §4.6 page pipeline against an already-loaded v3 store: cheap identity
 * prefilter → score → walk-ranked freshness fill → live rehydration.
 *
 * Returns the K freshest top-scoring page hits with live-rehydrated text plus
 * the ids dropped for staleness this read (reported, never written).
 */
export async function findRelevantPagesV3(
  root: string,
  store: EmbeddingStoreV3,
  surface: RetrievalSurface,
  question: string,
  k: number,
  profile?: LoadedProfile,
): Promise<{ hits: PageHitV3[]; stalePageIds: PageId[] }> {
  const namespaceDirs = buildNamespaceDirs(profile?.profile);
  const liveIds = await buildLiveIdSet(root, await activeNamespaces(root, profile), namespaceDirs, profile);
  const eligible = store.entries.filter((e) => passesPrefilter(e.pageId, liveIds, surface, profile));
  const queryVec = await embedQuery(question, store.dimensions);
  const ranked = scorePageEntries(queryVec, eligible);
  return walkFreshPages(root, ranked, k, namespaceDirs);
}

/**
 * Run the §4.6 chunk pipeline against an already-loaded v3 store. Same
 * prefilter→score→walk-ranked-freshness shape as the page pipeline, but a chunk
 * hit's freshness is verified against the live page's chunk-hash at its index.
 */
export async function findRelevantChunksV3(
  root: string,
  store: EmbeddingStoreV3,
  surface: RetrievalSurface,
  question: string,
  k: number,
  profile?: LoadedProfile,
): Promise<{ hits: ChunkHitV3[]; stalePageIds: PageId[] }> {
  const chunks = store.chunks ?? [];
  const namespaceDirs = buildNamespaceDirs(profile?.profile);
  const liveIds = await buildLiveIdSet(root, await activeNamespaces(root, profile), namespaceDirs, profile);
  const eligible = chunks.filter((c) => passesPrefilter(c.pageId, liveIds, surface, profile));
  const queryVec = await embedQuery(question, store.dimensions);
  const ranked = scoreChunkEntries(queryVec, eligible);
  return walkFreshChunks(root, ranked, k, namespaceDirs);
}

/** Embed the query string and assert the returned vector matches the store dim. */
async function embedQuery(question: string, dimensions: number): Promise<number[]> {
  const vec = await getProvider().embed(question, "query");
  assertVectorValid(vec, dimensions);
  return vec;
}

/** The namespaces a load scans: reserved dirs plus any profile entity types. */
async function activeNamespaces(_root: string, profile?: LoadedProfile): Promise<string[]> {
  const base = ["concepts", "queries"];
  if (!profile) return base;
  return [...base, ...Object.keys(profile.profile.entities)];
}

/**
 * Cheap identity prefilter (§4.6 step 3): a store entry survives iff its pageId
 * names a LIVE page AND its namespace passes the surface flag. Concepts/queries
 * always pass the flag; a typed namespace consults its `RetrievalDef`.
 */
function passesPrefilter(
  pageId: PageId,
  liveIds: Set<PageId>,
  surface: RetrievalSurface,
  profile?: LoadedProfile,
): boolean {
  if (!liveIds.has(pageId)) return false;
  return passesSurfaceFlag(pageId, surface, profile);
}

/** A typed namespace's `includeInSearch`/`includeInContext` flag (tri-state). */
function passesSurfaceFlag(pageId: PageId, surface: RetrievalSurface, profile?: LoadedProfile): boolean {
  const parsed = parseQualifiedPageId(pageId);
  if (!parsed || !profile) return true;
  const def = profile.profile.entities[parsed.namespace]?.retrieval;
  if (!def) return true;
  const flag = surface === "search" ? def.includeInSearch : def.includeInContext;
  return flag !== false;
}

/** Score page entries by cosine similarity, descending; ties keep input order. */
function scorePageEntries(
  queryVec: number[],
  entries: PageEmbeddingV3[],
): Array<{ entry: PageEmbeddingV3; score: number }> {
  const scored = entries.map((entry) => ({ entry, score: cosineSimilarity(queryVec, entry.vector) }));
  return stableSortByScore(scored, (item) => item.entry.pageId);
}

/** Score chunk entries by cosine similarity, descending; ties keep input order. */
function scoreChunkEntries(
  queryVec: number[],
  entries: ChunkEmbeddingV3[],
): Array<{ entry: ChunkEmbeddingV3; score: number }> {
  const scored = entries.map((entry) => ({ entry, score: cosineSimilarity(queryVec, entry.vector) }));
  return stableSortByScore(scored, (item) => `${item.entry.pageId}#${item.entry.chunkIndex}`);
}

/**
 * Sort by score descending, breaking ties on a STABLE non-key field (S7) so the
 * order is invariant under a slug→pageId re-key. The tie field is the qualified
 * id (or id+index), which is deterministic across the re-key.
 */
function stableSortByScore<T>(scored: Array<T & { score: number }>, tieKey: (item: T) => string): Array<T & { score: number }> {
  return scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return tieKey(a).localeCompare(tieKey(b));
  });
}

/**
 * One ranked candidate's freshness decision against the live registry entry:
 * `null` when stale/absent (drop + warn), otherwise the rehydrated hit.
 */
type FreshnessFill<E, H> = (
  entry: E,
  score: number,
  live: LiveRegistryEntry,
) => Promise<H | null>;

/**
 * Generic walk of the ranked pool (§4.6 step 5): per candidate (score order)
 * resolve its live registry entry, ask `fill` for a fresh rehydrated hit, keep
 * it or record the id as stale, and stop at K fresh hits or pool exhaustion.
 * This — NOT top-K-then-validate — is what prevents a stale high-score hit from
 * crowding out a lower-score fresh one.
 */
async function walkRankedFresh<E extends { pageId: PageId }, H>(
  root: string,
  ranked: Array<{ entry: E; score: number }>,
  k: number,
  namespaceDirs: NamespaceDirs,
  fill: FreshnessFill<E, H>,
): Promise<{ hits: H[]; stalePageIds: PageId[] }> {
  const hits: H[] = [];
  const stalePageIds: PageId[] = [];
  for (const { entry, score } of ranked) {
    if (hits.length >= k) break;
    const live = await buildLiveRegistryEntry(root, entry.pageId, namespaceDirs);
    const hit = live ? await fill(entry, score, live) : null;
    if (hit === null) stalePageIds.push(entry.pageId);
    else hits.push(hit);
  }
  return { hits, stalePageIds };
}

/** Walk page candidates, keeping a hit only when its `embeddingTextHash` is live. */
function walkFreshPages(
  root: string,
  ranked: Array<{ entry: PageEmbeddingV3; score: number }>,
  k: number,
  namespaceDirs: NamespaceDirs,
): Promise<{ hits: PageHitV3[]; stalePageIds: PageId[] }> {
  return walkRankedFresh(root, ranked, k, namespaceDirs, async (entry, score, live) =>
    live.embeddingTextHash === entry.embeddingTextHash ? rehydratePageHit(root, entry, score, namespaceDirs) : null,
  );
}

/** Walk chunk candidates, keeping a hit only when its `contentHash` is live. */
function walkFreshChunks(
  root: string,
  ranked: Array<{ entry: ChunkEmbeddingV3; score: number }>,
  k: number,
  namespaceDirs: NamespaceDirs,
): Promise<{ hits: ChunkHitV3[]; stalePageIds: PageId[] }> {
  return walkRankedFresh(root, ranked, k, namespaceDirs, async (entry, score, live) =>
    live.chunkHashes[entry.chunkIndex] === entry.contentHash
      ? rehydrateChunkHit(root, entry, score, live.chunkHashes[entry.chunkIndex], namespaceDirs)
      : null,
  );
}

/** Rehydrate a page hit's title/summary from the LIVE file, never the store (S12). */
async function rehydratePageHit(
  root: string,
  entry: PageEmbeddingV3,
  score: number,
  namespaceDirs: NamespaceDirs,
): Promise<PageHitV3> {
  const slug = parseQualifiedPageId(entry.pageId)?.pagePart ?? "";
  const live = await loadLivePage(root, entry.pageId, namespaceDirs);
  return {
    pageId: entry.pageId,
    slug,
    title: live?.title ?? "",
    summary: live?.summary ?? "",
    score,
  };
}

/**
 * Rehydrate a chunk hit's text from the LIVE page body (S12). The live body is
 * re-split with the SAME `splitIntoChunks` the store used, and the chunk at the
 * hit's index is taken — the store's cached `entry.text` is never returned, so a
 * poisoned cached value cannot reach output even if its hash matched live.
 */
async function rehydrateChunkHit(
  root: string,
  entry: ChunkEmbeddingV3,
  score: number,
  liveContentHash: string,
  namespaceDirs: NamespaceDirs,
): Promise<ChunkHitV3> {
  const live = await loadLivePage(root, entry.pageId, namespaceDirs);
  const liveText = live ? splitIntoChunks(live.body)[entry.chunkIndex] ?? "" : "";
  return {
    pageId: entry.pageId,
    slug: parseQualifiedPageId(entry.pageId)?.pagePart ?? "",
    chunkIndex: entry.chunkIndex,
    contentHash: liveContentHash,
    text: liveText,
    score,
  };
}

/** Resolve one live page record via the confined registry loader (absent → null). */
async function loadLivePage(
  root: string,
  pageId: PageId,
  namespaceDirs: NamespaceDirs,
): Promise<PageRecord | null> {
  const records = await loadPageRecordsByPageId(root, [pageId], namespaceDirs);
  return records[0] ?? null;
}
