/**
 * Semantic retrieval wrapper for `llmwiki context` (v3 pageId pipeline).
 *
 * Wraps the v3 read pipeline ({@link loadEmbeddingsForContext} →
 * {@link findRelevantChunksV3}) so the orchestrator never has to special-case
 * provider failures, missing stores, or degraded (non-v3 / unavailable / stale)
 * stores. Semantic retrieval is opportunistic — context packs keep working on
 * lexical signals alone when no usable v3 store is present OR the active provider
 * has no credentials. Each failure mode maps to a stable warning code the JSON
 * contract preserves.
 *
 * Degrade-on-read: a store that is not yet v3 (the writer pre-flip, an absent
 * store, or a stale-model store) yields `embedding-index-outdated` from the
 * loader; we surface that code directly so an agent SEES that the index is
 * outdated rather than getting a silently empty semantic section. The hits carry
 * a qualified `pageId`, and ranking resolves it via `findPageByQualifiedId`.
 *
 * Disk access: {@link retrieveSemanticChunks} loads the embedding store and the
 * profile from the project root and reads live pages through the root-named
 * lookup. {@link retrieveSemanticChunksFrom} takes a `LivePageReads` and the two
 * loads as functions instead. Both run one private body, which makes each call
 * only when it is reached: none for a non-positive limit, and no profile load
 * when there is no usable store.
 */

import {
  loadEmbeddingsForContext,
  findRelevantChunksV3,
  findRelevantChunksV3From,
  type ChunkHitV3,
  type EmbeddingLoadOutcome,
} from "../utils/embeddings-load.js";
import type { SearchableEmbeddingStore } from "../utils/embeddings-load.js";
import type { LivePageReads } from "../utils/page-registry.js";
import { loadProfile } from "../profile/load.js";
import type { LoadedProfile } from "../profile/types.js";
import { CHUNK_TOP_K } from "../utils/constants.js";

/** Stable warning code returned when semantic retrieval did not contribute. */
export type SemanticRetrievalWarning =
  | "embedding-store-missing"
  | "embedding-index-outdated"
  | "query-embedding-unavailable"
  | "semantic-retrieval-error";

/**
 * Slimmed chunk record passed from retrieval into ranking. Keeps `ranking.ts`
 * independent of the underlying embedding-store shape. Carries the qualified
 * `pageId` so ranking resolves it via `findPageByQualifiedId` (a concept `foo`
 * and a query `foo` stay distinct), plus the bare `slug` for display.
 */
export interface SemanticChunkHit {
  /** Qualified page id (`<namespace>/<page-part>`) — resolved in ranking. */
  pageId: string;
  /** Bare page slug (page-part) for display/grouping. */
  slug: string;
  /** Chunk body text — surfaced verbatim in `primary[].chunks[].text`. */
  text: string;
  /** Cosine similarity from the v3 chunk pipeline. */
  score: number;
  /** Live content hash of the chunk text; pass-through into the chunk entry. */
  contentHash: string;
}

/**
 * Outcome of one semantic retrieval call. Either `hits` is populated and
 * `warning` is `null`, or `hits` is empty and `warning` carries the stable code.
 *
 * `staleEntriesDetected` is an INDEPENDENT signal (it co-occurs with hits): the
 * read pipeline dropped at least one store entry as stale this call. It maps to
 * a top-level `embedding-entry-stale` warning, mirroring `embedding-index-outdated`
 * — a read-path signal only; the store is repaired on the next compile.
 */
export interface SemanticRetrievalOutcome {
  hits: SemanticChunkHit[];
  warning: SemanticRetrievalWarning | null;
  staleEntriesDetected: boolean;
}

/**
 * The two loads the semantic step makes, as functions, so that each runs only
 * when the step reaches it. {@link retrieveSemanticChunksFrom} calls them as
 * `loads.embeddings()` and `loads.profile()`. They stand for the two root
 * loaders; they are not a storage interface.
 */
export interface LazyContextLoads {
  /** Load the embedding store. A rejection is NOT caught: it rejects the step. */
  embeddings(): Promise<EmbeddingLoadOutcome>;
  /** Load the active profile. A rejection becomes a retrieval warning. */
  profile(): Promise<LoadedProfile>;
}

/** The three calls one retrieval makes, in the order the shared body makes them. */
interface SemanticSteps extends LazyContextLoads {
  chunks(store: SearchableEmbeddingStore, k: number, profile: LoadedProfile): ReturnType<typeof findRelevantChunksV3>;
}

/**
 * Best-effort semantic retrieval over the v3 store. Returns the top-k chunks the
 * active embedding store can offer for `prompt`, OR a warning explaining why
 * semantic retrieval contributed nothing this call.
 *
 * @param root - Project root path.
 * @param prompt - The ranking prompt (NOT the truncated display copy).
 * @param topChunks - Maximum chunks to retrieve (≤ 0 → no-op).
 */
export function retrieveSemanticChunks(
  root: string,
  prompt: string,
  topChunks: number,
): Promise<SemanticRetrievalOutcome> {
  return retrieveChunksLazily({
    embeddings: () => loadEmbeddingsForContext(root),
    profile: () => loadProfile(root),
    chunks: (store, k, profile) => findRelevantChunksV3(root, store, "context", prompt, k, profile),
  }, topChunks);
}

/**
 * {@link retrieveSemanticChunks} with every live page read made through `pages`
 * and the two loads supplied as functions. Nothing here takes a project root.
 *
 * @param pages - Where live pages are read from.
 * @param loads - The store load and the profile load, each called only when reached.
 * @param prompt - The ranking prompt (NOT the truncated display copy).
 * @param topChunks - Maximum chunks to retrieve (≤ 0 → no-op, and neither load runs).
 */
export function retrieveSemanticChunksFrom(
  pages: LivePageReads,
  loads: LazyContextLoads,
  prompt: string,
  topChunks: number,
): Promise<SemanticRetrievalOutcome> {
  return retrieveChunksLazily({
    embeddings: () => loads.embeddings(),
    profile: () => loads.profile(),
    chunks: (store, k, profile) => findRelevantChunksV3From(pages, store, "context", prompt, k, profile),
  }, topChunks);
}

/**
 * The one retrieval both forms share. The order is the contract: a non-positive
 * limit returns before any call; the store load is awaited OUTSIDE the `try`, so
 * its failure rejects; a missing store returns before the profile is loaded; the
 * profile load and the lookup are INSIDE the `try`, so their failures become a
 * warning.
 */
async function retrieveChunksLazily(steps: SemanticSteps, topChunks: number): Promise<SemanticRetrievalOutcome> {
  if (topChunks <= 0) return emptyOutcome(null);
  const outcome = await steps.embeddings();
  if (!outcome.store) return emptyOutcome(mapLoadWarning(outcome.warnings[0]?.code));

  try {
    const k = Math.min(topChunks, CHUNK_TOP_K);
    const profile = await steps.profile();
    const { hits, stalePageIds } = await steps.chunks(outcome.store, k, profile);
    const staleEntriesDetected = stalePageIds.length > 0;
    if (hits.length === 0) return emptyOutcome("embedding-store-missing", staleEntriesDetected);
    return { hits: hits.map(toSemanticChunkHit), warning: null, staleEntriesDetected };
  } catch (err) {
    return emptyOutcome(classifyRetrievalError(err));
  }
}

/** Build the empty-hits outcome shape; centralised to keep callers terse. */
function emptyOutcome(
  warning: SemanticRetrievalWarning | null,
  staleEntriesDetected = false,
): SemanticRetrievalOutcome {
  return { hits: [], warning, staleEntriesDetected };
}

/** Map a loader degrade warning code onto the context retrieval warning vocabulary. */
function mapLoadWarning(code: string | undefined): SemanticRetrievalWarning {
  if (code === "embedding-index-outdated") return "embedding-index-outdated";
  return "embedding-store-missing";
}

/** Classify failures without leaking raw provider or stack text into JSON. */
function classifyRetrievalError(err: unknown): SemanticRetrievalWarning {
  const message = err instanceof Error ? err.message : String(err);
  return looksLikeProviderFailure(message)
    ? "query-embedding-unavailable"
    : "semantic-retrieval-error";
}

/** Known provider/config/network failures that should keep the legacy warning code. */
function looksLikeProviderFailure(message: string): boolean {
  return /api[_ -]?key|auth|credential|token|provider|voyage|openai|ollama|timeout|fetch|econn|enotfound/i
    .test(message);
}

/** Project a v3 chunk hit onto the ranking-facing shape. */
function toSemanticChunkHit(hit: ChunkHitV3): SemanticChunkHit {
  return {
    pageId: hit.pageId,
    slug: hit.slug,
    text: hit.text,
    score: hit.score,
    contentHash: hit.contentHash,
  };
}
