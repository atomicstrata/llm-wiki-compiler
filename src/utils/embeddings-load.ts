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
 *
 * ONE GATE BODY. {@link gateActiveStoreFrom} decides every degrade-on-read
 * verdict over ONE supplied stored read, which takes no project root: absent,
 * unavailable, an older version, a failed search validation, and a store from a
 * different (or invalid) embedding configuration. Both surface loaders keep their
 * signatures and hand it the incumbent root read, called when asked.
 */

import {
  validateV3ForSearch,
  storeMatchesActiveEmbedding,
  type EmbeddingStoreV3,
  type PageEmbeddingV3,
  type ChunkEmbeddingV3,
} from "./embeddings-store.js";
import { readStoredEmbeddings, type StoredEmbeddingRead } from "./embeddings-storage.js";
import { compilerModelScope, CompilerOperationError } from "../sdk/compiler-model-scope.js";
import { isShardedView, shardedSearchOutcome, type ShardedVectorView } from "../vectors/store.js";
import { findRelevantChunksSharded, findRelevantPagesSharded } from "../vectors/search.js";
import { cosineSimilarity } from "./embeddings-search.js";
import {
  buildLiveIdSetFrom,
  readLiveContentHashesFrom,
  buildNamespaceDirs,
  diskLivePageReads,
  type LiveContentHashes,
  type LivePageReads,
} from "./page-registry.js";
import type { PageId } from "./page-id.js";
import type { LoadedProfile } from "../profile/types.js";
import {
  embedQuery, passesSurfaceFlag, rehydrateChunkHit, rehydratePageHit,
  type ChunkHitV3, type PageHitV3, type RetrievalSurface,
} from "./embeddings-hits.js";

export type { ChunkHitV3, PageHitV3, RetrievalSurface } from "./embeddings-hits.js";

/** Namespace→directory map resolved from the active profile (or reserved-only). */
type NamespaceDirs = Map<string, string>;

/** Structured warning surfaced in the outcome the consumer actually reads (S6). */
export interface EmbeddingWarning {
  code:
    | "embedding-index-outdated"
    | "embedding-store-unavailable"
    | "embedding-entry-stale"
    // A v3 store loaded, but the embedding CALL failed at read time (e.g. no
    // embedder credentials), so retrieval degraded to LLM/index selection.
    | "embedding-degraded";
  message: string;
}

/**
 * Outcome of a surface load. `store` is non-null only for a fully-handled v3
 * store; a v2/older/failed-gate/corrupt store degrades to `null` + a warning.
 */
export interface EmbeddingLoadOutcome {
  /** A materialized v3 store, or (on a `local-indexed` project) a view the find functions stream from. */
  store: EmbeddingStoreV3 | ShardedVectorView | null;
  warnings: EmbeddingWarning[];
  stalePageIds: PageId[];
}

/** What the find functions search: a materialized v3 store or a `local-indexed` vector view. */
export type SearchableEmbeddingStore = EmbeddingStoreV3 | ShardedVectorView;

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
 * Gate the on-disk store of `root` through {@link gateActiveStoreFrom}, the
 * incumbent read called when asked. A `local-indexed` project is gated on its
 * piecewise vector store instead and hands back a VIEW (no vectors loaded).
 */
async function gateActiveStore(root: string): Promise<EmbeddingLoadOutcome> {
  const host = compilerModelScope();
  if (host?.kind === "query") {
    const snapshot = host.retrievalStore;
    if (!snapshot) return host.refuse(new CompilerOperationError("retrieval_index_absent"));
    return { store: snapshot, warnings: [], stalePageIds: [] };
  }
  const sharded = await shardedSearchOutcome(root);
  if (sharded !== null) return sharded;
  return gateActiveStoreFrom(() => readStoredEmbeddings(root));
}

/**
 * Parse + gate the stored embeddings READ-ONLY: THE ONE BODY. Returns a usable
 * v3 store, or a degraded outcome (`store: null`) with a structured warning when
 * the store is not v3 (older version — the writer has not flipped yet), failed
 * the search gate (corrupt vectors / over-cap), was built by a different
 * embedding configuration (provider, endpoint, or model), or is absent. The
 * active configuration is consulted only after the store validated, and a
 * configuration that cannot be resolved degrades rather than throws.
 *
 * @param readStored - The one stored read; it takes no project root.
 */
export async function gateActiveStoreFrom(readStored: () => Promise<StoredEmbeddingRead>): Promise<EmbeddingLoadOutcome> {
  const result = await readStored();
  if (result.kind === "absent") return degraded("embedding-index-outdated", "No embedding index found.");
  if (result.kind === "unavailable") return degraded("embedding-store-unavailable", result.reason);
  const parsed = result.parsed;
  if (parsed.version !== 3) {
    return degraded("embedding-index-outdated", "Embedding index is an older version; rebuild with 'llmwiki compile'.");
  }
  const validation = validateV3ForSearch(parsed);
  if (!validation.available) {
    return degraded("embedding-store-unavailable", "Embedding index failed integrity validation; rebuilt on next compile.");
  }
  if (isStaleConfiguration(parsed.store)) {
    return degraded(
      "embedding-index-outdated",
      "Embedding index was built with a different embedding configuration; rebuild with 'llmwiki compile'.",
    );
  }
  return { store: parsed.store as unknown as EmbeddingStoreV3, warnings: [], stalePageIds: [] };
}

/**
 * True when the persisted store came from a different embedding configuration
 * (provider, model, or endpoint) than the active one.
 *
 * Still fails CLOSED on a throw: `resolveEmbeddingFingerprint` validates the
 * configured provider name, so a misspelled LLMWIKI_EMBEDDING_PROVIDER degrades
 * retrieval rather than propagating out of a read path that several callers do
 * not guard.
 */
function isStaleConfiguration(store: Record<string, unknown>): boolean {
  try {
    return !storeMatchesActiveEmbedding(store);
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
export function findRelevantPagesV3(
  root: string,
  store: EmbeddingStoreV3 | ShardedVectorView,
  surface: RetrievalSurface,
  question: string,
  k: number,
  profile?: LoadedProfile,
): Promise<{ hits: PageHitV3[]; stalePageIds: PageId[] }> {
  return findRelevantPagesV3From(diskLivePageReads(root), store, surface, question, k, profile);
}

/** {@link findRelevantPagesV3}, with every live page read made through `pages`. */
export async function findRelevantPagesV3From(
  pages: LivePageReads,
  store: EmbeddingStoreV3 | ShardedVectorView,
  surface: RetrievalSurface,
  question: string,
  k: number,
  profile?: LoadedProfile,
): Promise<{ hits: PageHitV3[]; stalePageIds: PageId[] }> {
  if (isShardedView(store)) return findRelevantPagesSharded(pages, store, surface, question, k, profile);
  const namespaceDirs = buildNamespaceDirs(profile?.profile);
  const liveIds = await buildLiveIdSetFrom(pages.scans, await activeNamespaces(profile), namespaceDirs, profile);
  const eligible = store.entries.filter((e) => passesPrefilter(e.pageId, liveIds, surface, profile));
  // Nothing to rank against — return before embedding. Skips a billed provider
  // round-trip whose result could only be scored against an empty pool.
  if (eligible.length === 0) return { hits: [], stalePageIds: [] };
  const queryVec = await embedQuery(question, store.dimensions);
  const ranked = scorePageEntries(queryVec, eligible);
  return walkFreshPages(pages, ranked, k, namespaceDirs);
}

/**
 * Run the §4.6 chunk pipeline against an already-loaded v3 store. Same
 * prefilter→score→walk-ranked-freshness shape as the page pipeline, but a chunk
 * hit's freshness is verified against the live page's chunk-hash at its index.
 */
export function findRelevantChunksV3(
  root: string,
  store: EmbeddingStoreV3 | ShardedVectorView,
  surface: RetrievalSurface,
  question: string,
  k: number,
  profile?: LoadedProfile,
): Promise<{ hits: ChunkHitV3[]; stalePageIds: PageId[] }> {
  return findRelevantChunksV3From(diskLivePageReads(root), store, surface, question, k, profile);
}

/** {@link findRelevantChunksV3}, with every live page read made through `pages`. */
export async function findRelevantChunksV3From(
  pages: LivePageReads,
  store: EmbeddingStoreV3 | ShardedVectorView,
  surface: RetrievalSurface,
  question: string,
  k: number,
  profile?: LoadedProfile,
): Promise<{ hits: ChunkHitV3[]; stalePageIds: PageId[] }> {
  if (isShardedView(store)) return findRelevantChunksSharded(pages, store, surface, question, k, profile);
  const chunks = store.chunks ?? [];
  const namespaceDirs = buildNamespaceDirs(profile?.profile);
  const liveIds = await buildLiveIdSetFrom(pages.scans, await activeNamespaces(profile), namespaceDirs, profile);
  const eligible = chunks.filter((c) => passesPrefilter(c.pageId, liveIds, surface, profile));
  // See findRelevantPagesV3 — no candidates means no reason to embed the query.
  if (eligible.length === 0) return { hits: [], stalePageIds: [] };
  const queryVec = await embedQuery(question, store.dimensions);
  const ranked = scoreChunkEntries(queryVec, eligible);
  return walkFreshChunks(pages, ranked, k, namespaceDirs);
}

/** The namespaces a load scans: reserved dirs plus any profile entity types. */
async function activeNamespaces(profile?: LoadedProfile): Promise<string[]> {
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
  live: LiveContentHashes,
) => Promise<H | null>;

/**
 * Generic walk of the ranked pool (§4.6 step 5): per candidate (score order)
 * resolve its live registry entry, ask `fill` for a fresh rehydrated hit, keep
 * it or record the id as stale, and stop at K fresh hits or pool exhaustion.
 * This — NOT top-K-then-validate — is what prevents a stale high-score hit from
 * crowding out a lower-score fresh one.
 */
async function walkRankedFresh<E extends { pageId: PageId }, H>(
  pages: LivePageReads,
  ranked: Array<{ entry: E; score: number }>,
  k: number,
  namespaceDirs: NamespaceDirs,
  fill: FreshnessFill<E, H>,
): Promise<{ hits: H[]; stalePageIds: PageId[] }> {
  const hits: H[] = [];
  const stalePageIds: PageId[] = [];
  for (const { entry, score } of ranked) {
    if (hits.length >= k) break;
    const live = await readLiveContentHashesFrom(pages.reads, entry.pageId, namespaceDirs);
    const hit = live ? await fill(entry, score, live) : null;
    if (hit === null) stalePageIds.push(entry.pageId);
    else hits.push(hit);
  }
  return { hits, stalePageIds };
}

/** Walk page candidates, keeping a hit only when its `embeddingTextHash` is live. */
function walkFreshPages(
  pages: LivePageReads,
  ranked: Array<{ entry: PageEmbeddingV3; score: number }>,
  k: number,
  namespaceDirs: NamespaceDirs,
): Promise<{ hits: PageHitV3[]; stalePageIds: PageId[] }> {
  return walkRankedFresh(pages, ranked, k, namespaceDirs, async (entry, score, live) =>
    live.embeddingTextHash === entry.embeddingTextHash ? rehydratePageHit(pages, entry, score, namespaceDirs) : null,
  );
}

/** Walk chunk candidates, keeping a hit only when its `contentHash` is live. */
function walkFreshChunks(
  pages: LivePageReads,
  ranked: Array<{ entry: ChunkEmbeddingV3; score: number }>,
  k: number,
  namespaceDirs: NamespaceDirs,
): Promise<{ hits: ChunkHitV3[]; stalePageIds: PageId[] }> {
  return walkRankedFresh(pages, ranked, k, namespaceDirs, async (entry, score, live) =>
    live.chunkHashes[entry.chunkIndex] === entry.contentHash
      ? rehydrateChunkHit(pages, entry, score, live.chunkHashes[entry.chunkIndex], namespaceDirs)
      : null,
  );
}
