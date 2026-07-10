/**
 * Semantic and LLM-based page retrieval for llmwiki (v3 pageId pipeline).
 *
 * Exports `pickSearchRefs`, which resolves relevant pages for a question through
 * the v3 read pipeline ({@link loadEmbeddingsForSearch} → chunk-level, then
 * page-level {@link findRelevantPagesV3}), then falls back to LLM-driven
 * selection over LIVE, surface-eligible, pageId-keyed candidates (NOT the
 * rendered `index.md` — see {@link selectFallbackRefs}). Every hit carries its
 * qualified `pageId`, so a concept `foo` and a query `foo` are distinct, and a
 * typed page surfaces under its `EntityId`. A degraded (non-v3 / unavailable)
 * store yields a structured warning instead of silently contributing nothing.
 *
 * `pickSearchSlugs` is the bare-slug compatibility shim (the legacy contract);
 * `loadSelectedRefs` rehydrates refs to full records from the LIVE files via the
 * confined registry loader (never store-cached text — S12).
 */

import {
  loadEmbeddingsForSearch,
  findRelevantChunksV3,
  findRelevantPagesV3,
  type EmbeddingWarning,
} from "../utils/embeddings-load.js";
import type { EmbeddingStoreV3 } from "../utils/embeddings-store.js";
import {
  loadSelectedPagesByPageId,
  loadPageRecordPairsByPageId,
  buildNamespaceDirs,
  buildSurfaceEligibleCandidates,
  type SurfaceCandidate,
  type PageRecordWithId,
} from "../utils/page-registry.js";
import type { PageId } from "../utils/page-id.js";
import { loadProfile } from "../profile/load.js";
import { selectPages } from "../commands/page-selection.js";
import { CHUNK_TOP_K, EMBEDDING_TOP_K } from "../utils/constants.js";
import type { LoadedProfile } from "../profile/types.js";
import type { PageRecord } from "../pages/read.js";
import { journalHealthWarning } from "../trust/journal-health-warning.js";
import type { JournalWarning } from "../trust/journal-health-warning.js";

/**
 * A warning surfaced on a search result: an embedding-degrade signal OR the
 * shared journal-health warning (`incomplete-compile` / `journal-unavailable`).
 * The two share a `{ code, message }` shape; a healthy, fully-compiled project
 * surfaces neither, so the default search warnings list stays empty.
 */
export type SearchWarning = EmbeddingWarning | JournalWarning;

/** A selected page reference carrying its qualified identity plus derived slug. */
export interface SelectedPageRef {
  pageId: PageId;
  slug: string;
  title: string;
  /** Whether the ref came from chunk-level, page-level, or index selection. */
  kind: "chunk" | "page" | "index";
}

/** Outcome of a search: ordered refs plus any degrade warnings (S6). */
export interface SearchSelection {
  refs: SelectedPageRef[];
  warnings: SearchWarning[];
}

/** Deduplicate refs by pageId, preserving first-seen ordering. */
function dedupeRefs(refs: SelectedPageRef[]): SelectedPageRef[] {
  const seen = new Set<PageId>();
  const out: SelectedPageRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.pageId)) continue;
    seen.add(ref.pageId);
    out.push(ref);
  }
  return out;
}

/**
 * Resolve search candidates through the v3 pipeline. Tries chunk-level retrieval
 * first (highest precision), then page-level embeddings, then LLM-driven index
 * selection. Carries forward any degrade warning from the embedding load.
 *
 * @param root - Absolute path to the wiki workspace root.
 * @param question - The query used to rank pages.
 * @returns Ordered refs (pageId-keyed) plus structured warnings.
 */
export async function pickSearchRefs(root: string, question: string): Promise<SearchSelection> {
  const profile = await loadProfile(root);
  const outcome = await loadEmbeddingsForSearch(root);
  // A pending/unavailable compile journal applies to the whole result regardless
  // of which retrieval branch wins, so prepend it to the base warnings ONCE. An
  // ok journal contributes nothing, so the default warnings list is unchanged.
  const journalWarning = await journalHealthWarning(root);
  const base: SearchWarning[] = journalWarning ? [journalWarning, ...outcome.warnings] : outcome.warnings;
  let warnings = base;
  if (outcome.store) {
    const semantic = await selectViaEmbeddings(root, outcome.store, question, profile);
    // Stale entries are a read-path signal regardless of hit count, so enrich the
    // warnings BEFORE branching — the all-stale/zero-hits fallback must keep it.
    warnings = withStaleWarning(base, semantic.stalePageIds);
    if (semantic.refs.length > 0) return { refs: dedupeRefs(semantic.refs), warnings };
  }
  const { refs } = await selectFallbackRefs(root, question, "search", profile);
  return { refs, warnings };
}

/** Outcome of the v3 selection: ordered refs plus the ids dropped for staleness. */
interface SemanticSelection {
  refs: SelectedPageRef[];
  stalePageIds: PageId[];
}

/**
 * Append an `embedding-entry-stale` warning when the read pipeline dropped any
 * store entry as stale (not-live / hash-mismatched), mirroring how a non-v3 load
 * surfaces `embedding-index-outdated`. A read-path signal only — the store is
 * repaired on the next compile, never mutated here.
 */
export function withStaleWarning(base: SearchWarning[], stalePageIds: PageId[]): SearchWarning[] {
  if (stalePageIds.length === 0) return base;
  return [
    ...base,
    {
      code: "embedding-entry-stale",
      message: "Some embedding entries are stale (their page changed or was removed); rebuild with 'llmwiki compile'.",
    },
  ];
}

/** Run the chunk-then-page v3 pipeline against a loaded v3 store. */
async function selectViaEmbeddings(
  root: string,
  store: EmbeddingStoreV3,
  question: string,
  profile: LoadedProfile,
): Promise<SemanticSelection> {
  const { hits: chunkHits, stalePageIds: chunkStale } =
    await findRelevantChunksV3(root, store, "search", question, CHUNK_TOP_K, profile);
  if (chunkHits.length > 0) {
    const refs = chunkHits.map((c) => ({ pageId: c.pageId, slug: c.slug, title: "", kind: "chunk" as const }));
    return { refs, stalePageIds: chunkStale };
  }
  const { hits: pageHits, stalePageIds: pageStale } =
    await findRelevantPagesV3(root, store, "search", question, EMBEDDING_TOP_K, profile);
  const refs = pageHits.map((p) => ({ pageId: p.pageId, slug: p.slug, title: p.title, kind: "page" as const }));
  return { refs, stalePageIds: pageStale };
}

/** Render a surface candidate as a selector bullet keyed by its QUALIFIED pageId. */
function renderCandidate(candidate: SurfaceCandidate): string {
  return `- **${candidate.pageId}**: ${candidate.title} — ${candidate.summary}`;
}

/**
 * LLM fallback selection over LIVE surface-eligible candidates (NOT the rendered
 * index): opted-out/both-false typed pages are never enumerated (privacy), and
 * each candidate is keyed by its qualified pageId so picks resolve to the right
 * namespace (a saved query → queries/<slug>, a typed page → <type>/<slug>) and
 * same-slug pages never collapse.
 *
 * A returned token that is not a KNOWN candidate pageId is dropped — never
 * fabricated into `concepts/<token>` (the old leak/mis-key bug).
 *
 * @param root - Absolute path to the wiki workspace root.
 * @param question - The query the model selects pages for.
 * @param surface - Retrieval surface whose flag gates typed candidates.
 * @param profile - Active loaded profile (entity types + directories).
 * @returns Resolved pageId-keyed refs plus the model's reasoning.
 */
export async function selectFallbackRefs(
  root: string,
  question: string,
  surface: "search" | "context",
  profile: LoadedProfile,
): Promise<{ refs: SelectedPageRef[]; reasoning: string }> {
  const namespaces = ["concepts", "queries", ...Object.keys(profile.profile.entities)];
  const dirs = buildNamespaceDirs(profile.profile);
  const candidates = await buildSurfaceEligibleCandidates(root, surface, namespaces, dirs, profile);
  const rendered = candidates.map(renderCandidate).join("\n");
  const { pages, reasoning } = await selectPages(question, rendered);
  const byPageId = new Map(candidates.map((c) => [c.pageId, c]));
  const refs = pages
    .map((token) => byPageId.get(token))
    .filter((c): c is SurfaceCandidate => c !== undefined)
    .map((c) => ({ pageId: c.pageId, slug: c.slug, title: c.title, kind: "index" as const }));
  return { refs, reasoning };
}

/**
 * Resolve relevant page slugs for a question — the bare-slug compatibility shim.
 * Internally runs the v3 pipeline and projects each ref to its slug, preserving
 * the legacy `string[]` return contract.
 *
 * @param root - Absolute path to the wiki workspace root.
 * @param question - The query used to rank pages.
 * @returns Ordered list of relevant page slugs.
 */
export async function pickSearchSlugs(root: string, question: string): Promise<string[]> {
  const { refs } = await pickSearchRefs(root, question);
  return refs.map((ref) => ref.slug);
}

/**
 * Load full content for selected refs from the LIVE files via the confined
 * registry loader (S12 — never store-cached text), skipping any that resolve to
 * an absent / out-of-tree page.
 *
 * @param root - Absolute path to the wiki workspace root.
 * @param refs - Selected page refs to hydrate.
 * @returns Populated page records for all found pages.
 */
export async function loadSelectedRefs(root: string, refs: SelectedPageRef[]): Promise<PageRecord[]> {
  const profile = await loadProfile(root);
  const namespaceDirs = buildNamespaceDirs(profile.profile);
  return loadSelectedPagesByPageId(root, refs.map((r) => r.pageId), namespaceDirs);
}

/**
 * Like {@link loadSelectedRefs}, but pair each hydrated record with the qualified
 * `pageId` it came from (same confined read, same absent/out-of-tree dropping).
 * Used by the answer-grounding path so each page renders under its namespaced id
 * (a `concepts/foo` and a `papers/foo` stay distinguishable to the answer LLM).
 *
 * @param root - Absolute path to the wiki workspace root.
 * @param refs - Selected page refs to hydrate.
 * @returns `{pageId, record}` pairs for all found pages.
 */
export async function loadSelectedRefRecords(root: string, refs: SelectedPageRef[]): Promise<PageRecordWithId[]> {
  const profile = await loadProfile(root);
  const namespaceDirs = buildNamespaceDirs(profile.profile);
  return loadPageRecordPairsByPageId(root, refs.map((r) => r.pageId), namespaceDirs);
}
