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
 * branch. We detect them HERE — not by waiting for `findRelevantChunks`
 * to return `[]` — because the embeddings module emits a
 * `output.status("!", ...)` warning to stdout via `console.log` when
 * `loadActiveStore` sees a stale model. That leak would corrupt
 * `llmwiki context --json` output (stdout must be pure JSON). Catching
 * the model mismatch up front avoids the embeddings module's warning
 * path entirely.
 *
 * Malformed embedding store files (truncated writes, hand-edits, etc.)
 * are also folded into `embedding-store-missing` rather than propagated
 * as crashes. `readEmbeddingStore` does not catch its own JSON parse
 * failures, so the wrapper guards both the read and the parse so
 * `context` keeps producing parseable output even when the store on
 * disk is broken.
 */

import {
  findRelevantChunks,
  readEmbeddingStore,
  resolveEmbeddingModel,
} from "../utils/embeddings.js";
import type { EmbeddingStore } from "../utils/embeddings.js";

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
    // Defensive: with the upfront stale-model + chunk-count checks the
    // only way to land here is a TOCTOU race where the store changed
    // between the pre-check read and `findRelevantChunks`. Surface as
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
 * True when the on-disk embedding store cannot supply chunks: file
 * missing, JSON malformed, v1 / empty v2 store, OR built with a
 * different embedding model than the active provider is using.
 *
 * The stale-model check MUST happen here (before any `findRelevantChunks`
 * call) so the embeddings module's stale-store warning — which writes
 * to stdout via `output.status` — never fires. That warning would
 * corrupt `--json` output. Same reasoning applies to malformed-JSON
 * reads: `readEmbeddingStore` lets `JSON.parse` throw, which would
 * crash the command with exit 1 unless we catch it here.
 */
async function isStoreUnusable(root: string): Promise<boolean> {
  const store = await tryReadEmbeddingStore(root);
  if (!store) return true;
  if (!store.chunks || store.chunks.length === 0) return true;
  if (isStaleModel(store)) return true;
  return false;
}

/**
 * Wrap `readEmbeddingStore` so a missing OR malformed file both reduce
 * to `null`. The reader does `await readFile` + `JSON.parse` without
 * its own catch, so a broken store would otherwise surface as an
 * unhandled rejection to the caller.
 */
async function tryReadEmbeddingStore(root: string): Promise<EmbeddingStore | null> {
  try {
    return await readEmbeddingStore(root);
  } catch {
    return null;
  }
}

/**
 * Compare the persisted store's embedding model against the active
 * provider's resolved model. Returns true when they disagree so the
 * caller can fall back without triggering the embeddings module's
 * stdout warning. Defensive: a thrown `resolveEmbeddingModel` (e.g.
 * unknown `LLMWIKI_PROVIDER`) is also treated as stale.
 */
function isStaleModel(store: EmbeddingStore): boolean {
  try {
    return store.model !== resolveEmbeddingModel();
  } catch {
    return true;
  }
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
