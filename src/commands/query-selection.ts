/**
 * Page-selection half of the `llmwiki query` pipeline (Step 1).
 *
 * Extracted from `commands/query.ts` (which keeps the answer-generation half)
 * so each file stays within the size budget. Exposes {@link selectRelevantPages},
 * which picks relevant pages through the v3 read pipeline: chunk-aware
 * pre-filter when available, then page-level embeddings, then an LLM fallback
 * over LIVE, surface-eligible, pageId-keyed candidates.
 *
 * A failed chunk pre-filter falls through to page-level retrieval. Page-level
 * failures propagate by default; explicit fallback retains the D29 recovery
 * capability with an `embedding-degraded` warning.
 */

import * as output from "../utils/output.js";
import {
  QUERY_PAGE_LIMIT,
  CHUNK_TOP_K,
  CHUNK_RERANK_KEEP,
  EMBEDDING_TOP_K,
} from "../utils/constants.js";
import type { ChunkEmbeddingEntry } from "../utils/embeddings.js";
import {
  loadEmbeddingsForSearch,
  findRelevantChunksV3,
  findRelevantPagesV3,
} from "../utils/embeddings-load.js";
import { loadProfile } from "../profile/load.js";
import { rerankWithBm25 } from "../utils/retrieval.js";
import { journalHealthWarning } from "../trust/journal-health-warning.js";
import {
  selectFallbackRefs,
  withStaleWarning,
  type SelectedPageRef,
  type SearchWarning,
  type RetrievalOptions,
} from "../search/retrieval.js";
import type { PageId } from "../utils/page-id.js";
import { selectPages } from "./page-selection.js";
import type { ChunkCitation, RetrievalDebug } from "../utils/types.js";

/**
 * Render candidate pages in the bullet format selectPages() consumes, keyed by
 * each candidate's QUALIFIED `pageId` (NOT bare slug) so same-slug pages
 * (`concepts/foo` vs `papers/foo`) stay distinct keys and the LLM returns the
 * `namespace/slug` token verbatim — mirrors `selectFallbackRefs`'s renderer.
 */
function buildFilteredIndex(
  candidates: Array<{ pageId: PageId; title: string; summary: string }>,
): string {
  return candidates
    .map((entry) => `- **${entry.pageId}**: ${entry.title} — ${entry.summary}`)
    .join("\n");
}

/** Outcome of Step 1: the refs, chunks, and warnings the answer step consumes. */
export interface SelectedPages {
  /** Canonical qualified refs the answer grounds on (pageId-keyed). */
  refs: SelectedPageRef[];
  reasoning: string;
  /** Chunk citations driving the selection — empty when chunk store is absent. */
  chunks: ChunkCitation[];
  /** Debug snapshot of the retrieval pipeline (only populated in debug mode). */
  debug?: RetrievalDebug;
  /** Embedding-load degrade + journal-health warnings (S6); surfaced in the QueryResult. */
  warnings: SearchWarning[];
}

/**
 * The loaded store narrowed to `pageScope` (D-GROUNDING-SCOPE): page entries and chunks
 * outside the scope are dropped BEFORE any ranking, so an in-scope page can never be
 * crowded out of the top-k by one the caller is not allowed to ground on. No scope
 * returns the outcome untouched.
 */
function narrowToScope(
  outcome: Awaited<ReturnType<typeof loadEmbeddingsForSearch>>, pageScope: readonly string[] | undefined,
): Awaited<ReturnType<typeof loadEmbeddingsForSearch>> {
  if (pageScope === undefined || !outcome.store) return outcome;
  const allowed = new Set(pageScope);
  const store = outcome.store;
  return {
    ...outcome,
    store: {
      ...store,
      entries: store.entries.filter((entry) => allowed.has(entry.pageId)),
      ...(store.chunks === undefined ? {} : { chunks: store.chunks.filter((chunk) => allowed.has(chunk.pageId)) }),
    },
  };
}

/**
 * Pick relevant pages through the v3 read pipeline: chunk-aware pre-filter when
 * available, then page-level embeddings, then an LLM fallback over LIVE,
 * surface-eligible, pageId-keyed candidates (opted-out typed pages never reach
 * the selector). A degraded (non-v3 / unavailable) store carries its warning
 * through to the result (S6).
 */
export async function selectRelevantPages(
  root: string,
  question: string,
  debug: boolean,
  pageScope?: readonly string[],
  options: RetrievalOptions = {},
): Promise<SelectedPages> {
  const profile = await loadProfile(root);
  const outcome = narrowToScope(await loadEmbeddingsForSearch(root), pageScope);
  // A pending/unavailable compile journal applies to the whole answer regardless
  // of which retrieval branch wins, so fold it into the base warnings ONCE. An
  // ok journal contributes nothing, so a healthy query's warnings are unchanged.
  const journalWarning = await journalHealthWarning(root);
  const base: SearchWarning[] = journalWarning ? [journalWarning, ...outcome.warnings] : outcome.warnings;
  // Degrade warnings raised by THIS selection (e.g. a failed page-level embed).
  const degradeWarnings: SearchWarning[] = [];
  // Stale entries dropped by EITHER read path are accumulated here and folded
  // into the final warnings, so the all-stale/zero-hits fallback still surfaces
  // `embedding-entry-stale` (a read-path signal regardless of hit count).
  const stalePageIds: PageId[] = [];
  const enrich = (sel: SelectedPages): SelectedPages => ({
    ...sel,
    warnings: withStaleWarning([...base, ...degradeWarnings], stalePageIds),
  });

  if (outcome.store) {
    const chunkSelection = await trySelectViaChunks(root, outcome.store, question, debug, profile, stalePageIds);
    if (chunkSelection) return enrich(chunkSelection);
    const candidates = await tryFindRelevantPages(root, outcome.store, question, profile, options);
    stalePageIds.push(...candidates.stalePageIds);
    if (candidates.warning) degradeWarnings.push(candidates.warning);
    if (candidates.hits.length > 0) return enrich(await selectFromCandidates(question, candidates.hits));
  }

  const { refs, reasoning } = await selectFallbackRefs(root, question, "search", profile, pageScope);
  return enrich({ refs, reasoning, chunks: [], warnings: [] });
}

/** Page-level candidate hits plus an optional opt-in recovery warning. */
interface PageLookup {
  hits: Awaited<ReturnType<typeof findRelevantPagesV3>>["hits"];
  stalePageIds: PageId[];
  warning?: SearchWarning;
}

/**
 * Preserve public page-level embedding errors unless fallback is requested.
 * Recovery is reported as data rather than an additional stdout diagnostic.
 */
async function tryFindRelevantPages(
  root: string,
  store: NonNullable<Awaited<ReturnType<typeof loadEmbeddingsForSearch>>["store"]>,
  question: string,
  profile: Awaited<ReturnType<typeof loadProfile>>,
  options: RetrievalOptions,
): Promise<PageLookup> {
  try {
    return await findRelevantPagesV3(root, store, "search", question, EMBEDDING_TOP_K, profile);
  } catch (err) {
    if (options.embeddingFailure !== "fallback") throw err;
    const message = err instanceof Error ? err.message : String(err);
    return {
      hits: [],
      stalePageIds: [],
      warning: {
        code: "embedding-degraded",
        message: `Page-level embedding failed (${message}); degraded to LLM/index fallback selection.`,
      },
    };
  }
}

/**
 * Run LLM selection over a filtered candidate index built from page-level hits.
 * Candidates are rendered AND resolved by their qualified `pageId`, so a typed
 * page keeps its namespace and same-slug pages never collapse. A returned token
 * that is not a KNOWN candidate pageId is DROPPED — never fabricated into
 * `concepts/<token>` — mirroring `selectFallbackRefs`.
 */
async function selectFromCandidates(
  question: string,
  hits: Array<{ pageId: PageId; slug: string; title: string; summary: string }>,
): Promise<SelectedPages> {
  const filteredIndex = buildFilteredIndex(hits);
  const { pages: rawTokens, reasoning } = await selectPages(question, filteredIndex);
  const byPageId = new Map(hits.map((h) => [h.pageId, h]));
  const refs = rawTokens
    .map((token) => byPageId.get(token as PageId))
    .filter((hit): hit is (typeof hits)[number] => hit !== undefined)
    .map((hit) => ({ pageId: hit.pageId, slug: hit.slug, title: hit.title, kind: "page" as const }));
  return { refs, reasoning, chunks: [], warnings: [] };
}

/**
 * Attempt chunk-level retrieval + reranking against the loaded v3 store. Returns
 * null when no chunk hits exist (caller falls back to page-level retrieval). Any
 * stale entries the chunk read dropped are pushed onto `stalePageIds` (even when
 * this returns null) so the caller can surface `embedding-entry-stale`.
 */
async function trySelectViaChunks(
  root: string,
  store: NonNullable<Awaited<ReturnType<typeof loadEmbeddingsForSearch>>["store"]>,
  question: string,
  debug: boolean,
  profile: Awaited<ReturnType<typeof loadProfile>>,
  stalePageIds: PageId[],
): Promise<SelectedPages | null> {
  const ranked = await tryFindRelevantChunks(root, store, question, profile);
  stalePageIds.push(...ranked.stalePageIds);
  if (ranked.chunks.length === 0) return null;

  const reranked = rerankWithBm25(
    question,
    ranked.chunks.map(({ chunk, pageId, score }) => ({ text: chunk.text, baseScore: score, chunk, pageId })),
  );
  const kept = reranked.slice(0, CHUNK_RERANK_KEEP);
  const reorderingHappened = wasReordered(ranked.chunks, kept.map((k) => k.candidate.chunk));
  const chunkCitations = toChunkCitations(kept);
  const refs = collapseToRefs(kept, QUERY_PAGE_LIMIT);
  const reasoning = buildChunkReasoning(chunkCitations, refs);

  return {
    refs,
    reasoning,
    chunks: chunkCitations,
    warnings: [],
    debug: debug ? buildDebug(chunkCitations, refs, reorderingHappened) : undefined,
  };
}

/** Detect whether reranking actually changed the chunk order. */
function wasReordered(
  before: Array<{ chunk: ChunkEmbeddingEntry }>,
  after: ChunkEmbeddingEntry[],
): boolean {
  const limit = Math.min(before.length, after.length);
  for (let i = 0; i < limit; i++) {
    if (before[i].chunk !== after[i]) return true;
  }
  return false;
}

/** A reranked chunk candidate, carrying its parent page's qualified id. */
interface RankedChunk {
  candidate: { chunk: ChunkEmbeddingEntry; pageId: PageId };
  score: number;
}

/** Convert reranked candidates into citation records consumed downstream. */
function toChunkCitations(ranked: RankedChunk[]): ChunkCitation[] {
  return ranked.map(({ candidate, score }) => ({
    pageId: candidate.pageId,
    slug: candidate.chunk.slug,
    title: candidate.chunk.title,
    chunkIndex: candidate.chunk.chunkIndex,
    score,
    text: candidate.chunk.text,
  }));
}

/**
 * Collapse reranked chunks down to a deduplicated list of parent page REFS,
 * keyed by qualified `pageId` (NOT bare slug) so a typed `papers/foo` chunk and
 * a concept `foo` chunk stay distinct. First-seen order is preserved.
 */
function collapseToRefs(ranked: RankedChunk[], limit: number): SelectedPageRef[] {
  const refs: SelectedPageRef[] = [];
  const seen = new Set<PageId>();
  for (const { candidate } of ranked) {
    if (seen.has(candidate.pageId)) continue;
    seen.add(candidate.pageId);
    refs.push({ pageId: candidate.pageId, slug: candidate.chunk.slug, title: candidate.chunk.title, kind: "chunk" });
    if (refs.length >= limit) break;
  }
  return refs;
}

/** Human-readable reasoning trail for the chunk-driven selection. */
function buildChunkReasoning(chunks: ChunkCitation[], refs: SelectedPageRef[]): string {
  const top = chunks.slice(0, refs.length);
  const summary = top.map((c) => `${c.pageId}#${c.chunkIndex} (${c.score.toFixed(3)})`).join(", ");
  return `Selected ${refs.length} page(s) from ${chunks.length} reranked chunks: ${summary}`;
}

/** Snapshot used by debug mode — pure data, no side-effects. */
function buildDebug(
  chunks: ChunkCitation[],
  refs: SelectedPageRef[],
  reranked: boolean,
): RetrievalDebug {
  const bestPerPage = new Map<PageId, number>();
  for (const c of chunks) {
    const prev = bestPerPage.get(c.pageId);
    if (prev === undefined || c.score > prev) bestPerPage.set(c.pageId, c.score);
  }
  return {
    pages: refs.map((ref) => ({ pageId: ref.pageId, score: bestPerPage.get(ref.pageId) ?? 0 })),
    chunks,
    usedChunks: true,
    reranked,
  };
}

/** Reranker-ready chunk candidates plus the ids the chunk read dropped as stale. */
interface ChunkLookup {
  chunks: Array<{ chunk: ChunkEmbeddingEntry; pageId: PageId; score: number }>;
  stalePageIds: PageId[];
}

/**
 * Chunk-level candidate lookup over the v3 store that never throws. Adapts each
 * live-rehydrated {@link findRelevantChunksV3} hit to the chunk-entry shape the
 * BM25 reranker consumes (its `title` is the slug — query provenance shows the
 * slug, not the title) and forwards the read's `stalePageIds` so the caller can
 * surface `embedding-entry-stale`. Provider failures degrade to an empty list.
 */
async function tryFindRelevantChunks(
  root: string,
  store: NonNullable<Awaited<ReturnType<typeof loadEmbeddingsForSearch>>["store"]>,
  question: string,
  profile: Awaited<ReturnType<typeof loadProfile>>,
): Promise<ChunkLookup> {
  try {
    const { hits, stalePageIds } = await findRelevantChunksV3(root, store, "search", question, CHUNK_TOP_K, profile);
    return { chunks: hits.map((hit) => ({ chunk: toChunkEntry(hit), pageId: hit.pageId, score: hit.score })), stalePageIds };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.status("!", output.dim(`Chunk pre-filter unavailable (${message}); falling back.`));
    return { chunks: [], stalePageIds: [] };
  }
}

/** Project a v3 chunk hit onto the chunk-entry shape the reranker/citations use. */
function toChunkEntry(hit: { slug: string; chunkIndex: number; text: string; contentHash: string }): ChunkEmbeddingEntry {
  return {
    slug: hit.slug,
    title: hit.slug,
    chunkIndex: hit.chunkIndex,
    contentHash: hit.contentHash,
    text: hit.text,
    vector: [],
    updatedAt: "",
  };
}
