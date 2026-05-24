/**
 * Semantic retrieval wrapper for `llmwiki context` Slice 2.
 *
 * Wraps `readEmbeddingStore()` + `findRelevantChunks()` so the
 * orchestrator never has to special-case provider failures, missing
 * stores, or stale-model stores. Semantic retrieval is opportunistic
 * here — context packs must keep working on lexical signals alone when
 * the embedding store is absent OR the active provider has no
 * credentials. The wrapper translates both failure modes into stable
 * warning codes (`embedding-store-missing` / `query-embedding-unavailable`)
 * so the JSON contract stays predictable for agents regardless of which
 * branch fired.
 *
 * Stale-model stores are folded into the `embedding-store-missing`
 * branch because `findRelevantChunks()` -> `loadActiveStore()` already
 * silently skips them; the user-visible distinction is "no usable
 * chunks contributed", which both codes communicate.
 */

import { findRelevantChunks, readEmbeddingStore } from "../utils/embeddings.js";

/** Stable warning code returned when semantic retrieval did not contribute. */
export type SemanticRetrievalWarning =
  | "embedding-store-missing"
  | "query-embedding-unavailable";

/**
 * Slimmed chunk record passed from retrieval into ranking. Keeps
 * `ranking.ts` independent of the underlying `ChunkEmbeddingEntry`
 * shape so the embedding store can evolve without churn here.
 */
export interface SemanticChunkHit {
  /** Source page slug; bare-slug resolved against the viewer snapshot in ranking. */
  slug: string;
  /** Chunk body text — surfaced verbatim in `primary[].chunks[].text`. */
  text: string;
  /** Cosine similarity from `findTopKChunks`; pass-through into the chunk entry. */
  score: number;
  /** Stable hash of the chunk text; pass-through into the chunk entry. */
  contentHash: string;
}

/**
 * Outcome of one semantic retrieval call. Either `hits` is populated and
 * `warning` is `null`, or `hits` is empty and `warning` carries the
 * stable code. We use mutually-exclusive null/value rather than a tagged
 * union so callers can spread both fields into the envelope without
 * widening narrow types.
 */
export interface SemanticRetrievalOutcome {
  hits: SemanticChunkHit[];
  warning: SemanticRetrievalWarning | null;
}

/**
 * Best-effort semantic retrieval. Returns the top-k chunks the active
 * embedding store can offer for `prompt`, OR a warning that explains
 * why semantic retrieval contributed nothing this call.
 *
 * Precondition: caller already knows the original prompt should be
 * passed (not the truncated display copy). Slice 2 wires the orchestrator
 * to pass `NormalizedOptions.rankingPrompt`.
 */
export async function retrieveSemanticChunks(
  root: string,
  prompt: string,
  topChunks: number,
): Promise<SemanticRetrievalOutcome> {
  if (topChunks <= 0) return emptyOutcome(null);
  if (await isStoreUnusable(root)) return emptyOutcome("embedding-store-missing");

  let raw: Awaited<ReturnType<typeof findRelevantChunks>>;
  try {
    raw = await findRelevantChunks(root, prompt, topChunks);
  } catch {
    // Provider call failed — usually missing credentials, occasionally a
    // transient network blip. Either way, lexical fallback continues
    // and the warning is what tells the agent what just happened.
    return emptyOutcome("query-embedding-unavailable");
  }

  if (raw.length === 0) {
    // Store had chunks at the pre-check moment, but `findRelevantChunks`
    // returned nothing. The only path that fits is a stale-model store
    // (loadActiveStore silently dropped it). Surface as
    // `embedding-store-missing` so the warning vocabulary stays small.
    return emptyOutcome("embedding-store-missing");
  }

  return { hits: raw.map(toSemanticChunkHit), warning: null };
}

/** Build the empty-hits outcome shape; centralised to keep callers terse. */
function emptyOutcome(warning: SemanticRetrievalWarning | null): SemanticRetrievalOutcome {
  return { hits: [], warning };
}

/**
 * True when the on-disk embedding store cannot supply chunks at all
 * (missing file, v1 page-only store, or v2 store with an empty chunk
 * array). Stale-model is intentionally NOT detected here — it surfaces
 * via the post-call empty-result branch above so we don't reimplement
 * the model-comparison logic already in `loadActiveStore`.
 */
async function isStoreUnusable(root: string): Promise<boolean> {
  const store = await readEmbeddingStore(root);
  if (!store) return true;
  if (!store.chunks || store.chunks.length === 0) return true;
  return false;
}

/** Project an embedding-store chunk hit onto the ranking-facing shape. */
function toSemanticChunkHit(
  raw: Awaited<ReturnType<typeof findRelevantChunks>>[number],
): SemanticChunkHit {
  return {
    slug: raw.chunk.slug,
    text: raw.chunk.text,
    score: raw.score,
    contentHash: raw.chunk.contentHash,
  };
}
