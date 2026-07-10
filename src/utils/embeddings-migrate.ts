/**
 * Pure v2→v3 embedding-store migration core (spec §4.4, Task D5).
 *
 * `migrateEmbeddingStore` is a side-effect-free transform: it takes the
 * version-discriminated old store, the set of VALID + ELIGIBLE live pages (the
 * caller supplies these — this module never touches the filesystem or a
 * provider), and the active model name, and returns a v3 store plus the list of
 * eligible pageIds whose vectors could not be preserved and must therefore be
 * re-embedded by the caller.
 *
 * Centralizing the migration here keeps two hard guarantees in one place:
 *  - CONTENT VERIFICATION: a preserved v2 vector is only re-keyed when the live
 *    page's content still hashes to the same embedding input (page) or the same
 *    chunk contentHash at the same index (chunk). Anything else re-embeds.
 *  - S2 PRIVACY (eligibility-gated): `reembedPageIds` only ever contains pages
 *    present in `eligibleLivePages`. A deleted page (no live page) or an
 *    opted-out / ineligible page (absent from `eligibleLivePages`) is dropped
 *    from the output store and is NEVER re-embedded — its old vector is not
 *    carried forward and the provider is never asked to embed it. "Couldn't
 *    preserve" must not default to "re-embed"; only eligibility does.
 *
 * This module is intentionally unwired in PR4D — the atomic write-flip task
 * (D7) routes `updateEmbeddings` through it. Until then the writer stays on v2.
 */

import { hashChunkText } from "./retrieval.js";
import { buildEmbeddingText } from "./embeddings-pages.js";
import { assertEmbeddingStoreValid } from "./embeddings-validate.js";
import type {
  ParsedStore,
  EmbeddingStoreV3,
  PageEmbeddingV3,
  ChunkEmbeddingV3,
} from "./embeddings-store.js";
import type { PageId } from "./page-id.js";

/**
 * A valid + eligible live page, supplied by the caller with enough material to
 * build the bare-slug→pageId map and verify that a preserved vector still
 * matches the page's current content.
 */
export interface EligibleLivePage {
  /** Qualified `<namespace>/<page-part>` identity to re-key preserved vectors to. */
  pageId: PageId;
  /** The bare slug an old v2 entry would have been keyed under. */
  bareSlug: string;
  /** `hashChunkText(buildEmbeddingText(title, summary))` for the live page. */
  embeddingTextHash: string;
  /** `hashChunkText` of each live chunk body, in chunk order. */
  chunkContentHashes: string[];
}

/** Result of a migration: the v3 store plus the eligible pages to re-embed. */
export interface MigrationResult {
  store: EmbeddingStoreV3;
  reembedPageIds: PageId[];
}

/**
 * Migrate a parsed old store to v3, preserving content-verified vectors and
 * reporting the eligible pages that must be re-embedded. Pure — see file docs.
 */
export function migrateEmbeddingStore(
  parsedOld: ParsedStore | null,
  eligibleLivePages: EligibleLivePage[],
  activeModel: string,
): MigrationResult {
  const dims = storeDimensions(parsedOld);
  if (shouldRebuild(parsedOld, activeModel)) {
    return rebuild(parsedOld, eligibleLivePages, activeModel);
  }
  const slugToPageIds = indexBySlug(eligibleLivePages);
  const liveByPageId = new Map(eligibleLivePages.map((p) => [p.pageId, p]));
  const reembed = new Set<PageId>();
  const entries = migrateEntries(parsedOld!.store, slugToPageIds, liveByPageId, reembed);
  const chunks = migrateChunks(parsedOld!.store, slugToPageIds, liveByPageId, reembed);
  addNewEligiblePages(eligibleLivePages, entries, reembed);
  return { store: { version: 3, model: activeModel, dimensions: dims, entries, chunks }, reembedPageIds: [...reembed] };
}

/** Rebuild-only: empty v3 store + EVERY eligible pageId queued for re-embedding. */
function rebuild(parsedOld: ParsedStore | null, pages: EligibleLivePage[], model: string): MigrationResult {
  return {
    store: { version: 3, model, dimensions: storeDimensions(parsedOld), entries: [], chunks: [] },
    reembedPageIds: pages.map((p) => p.pageId),
  };
}

/** Read the declared dimension (default 0) from a parsed store of any version. */
function storeDimensions(parsedOld: ParsedStore | null): number {
  const dims = parsedOld?.store.dimensions;
  return typeof dims === "number" && Number.isFinite(dims) ? dims : 0;
}

/**
 * Gate to rebuild-only when no vector can be safely preserved: a missing /
 * v1 / v>3 store, a stored model that differs from the active model, or any
 * vector-integrity failure (non-finite / wrong-length against `dimensions`).
 */
function shouldRebuild(parsedOld: ParsedStore | null, activeModel: string): boolean {
  if (!parsedOld || parsedOld.version < 2 || parsedOld.version > 3) return true;
  if (parsedOld.store.model !== activeModel) return true;
  try {
    assertEmbeddingStoreValid(parsedOld.store);
    return false;
  } catch {
    return true;
  }
}

/** Build `bareSlug → eligible live pageIds[]` (a slug may map to >1 → ambiguous). */
function indexBySlug(pages: EligibleLivePage[]): Map<string, PageId[]> {
  const bySlug = new Map<string, PageId[]>();
  for (const page of pages) {
    const ids = bySlug.get(page.bareSlug) ?? [];
    ids.push(page.pageId);
    bySlug.set(page.bareSlug, ids);
  }
  return bySlug;
}

/**
 * Re-key the v3 page entries. A v2 entry is preserved only when its bare slug
 * maps to EXACTLY ONE eligible live page and the live page's content hash still
 * equals the v2 entry's recomputed `buildEmbeddingText` hash. Any other case
 * (ambiguous, `/`-in-slug, content drift) queues that eligible page to re-embed.
 */
function migrateEntries(
  store: Record<string, unknown>,
  slugToPageIds: Map<string, PageId[]>,
  liveByPageId: Map<PageId, EligibleLivePage>,
  reembed: Set<PageId>,
): PageEmbeddingV3[] {
  if (isV3(store)) return reconcileV3Entries(store, liveByPageId, reembed);
  const out: PageEmbeddingV3[] = [];
  for (const raw of asArray(store.entries)) {
    const entry = raw as Record<string, unknown>;
    const pageId = soleEligiblePageId(slugToPageIds, entry.slug);
    const live = pageId ? liveByPageId.get(pageId) : undefined;
    if (pageId && live && hashEntryText(entry) === live.embeddingTextHash) {
      out.push(toPageV3(entry, pageId, live.embeddingTextHash));
    } else if (pageId) {
      reembed.add(pageId);
    }
  }
  return out;
}

/**
 * v3 idempotent reconciliation of page entries: keep a record only when its
 * pageId is an eligible live page whose `embeddingTextHash` still matches the
 * stored value. A dropped record that is still eligible (content drift) is queued
 * to re-embed; a record for a deleted/opted-out page is pruned silently.
 */
function reconcileV3Entries(
  store: Record<string, unknown>,
  liveByPageId: Map<PageId, EligibleLivePage>,
  reembed: Set<PageId>,
): PageEmbeddingV3[] {
  const out: PageEmbeddingV3[] = [];
  for (const entry of (store.entries as PageEmbeddingV3[] | undefined) ?? []) {
    const live = liveByPageId.get(entry.pageId);
    if (live && entry.embeddingTextHash === live.embeddingTextHash) out.push(entry);
    else if (live) reembed.add(entry.pageId);
  }
  return out;
}

/**
 * Re-key the v3 chunk entries. A chunk is preserved only when its eligible live
 * page has a chunk at the same index whose contentHash matches. A duplicate old
 * `(slug,index)` key, a missing/changed live chunk, or an ineligible/ambiguous
 * page drops the chunk and (when the page is eligible) queues it to re-embed.
 */
function migrateChunks(
  store: Record<string, unknown>,
  slugToPageIds: Map<string, PageId[]>,
  liveByPageId: Map<PageId, EligibleLivePage>,
  reembed: Set<PageId>,
): ChunkEmbeddingV3[] {
  if (isV3(store)) return reconcileV3Chunks(store, liveByPageId, reembed);
  const out: ChunkEmbeddingV3[] = [];
  const seen = new Set<string>();
  for (const raw of asArray(store.chunks)) {
    const chunk = raw as Record<string, unknown>;
    const pageId = soleEligiblePageId(slugToPageIds, chunk.slug);
    if (!pageId) continue;
    if (isChunkPreservable(chunk, liveByPageId.get(pageId), pageId, seen)) {
      out.push(toChunkV3(chunk, pageId));
    } else {
      reembed.add(pageId);
    }
  }
  return out;
}

/**
 * v3 idempotent reconciliation of chunk entries: keep a chunk only when its
 * pageId is an eligible live page whose chunk-hash at the same index still
 * matches. A drifted/absent chunk on a live page is pruned and its page queued
 * to re-embed; a chunk for a deleted/opted-out page is pruned silently.
 */
function reconcileV3Chunks(
  store: Record<string, unknown>,
  liveByPageId: Map<PageId, EligibleLivePage>,
  reembed: Set<PageId>,
): ChunkEmbeddingV3[] {
  const out: ChunkEmbeddingV3[] = [];
  for (const chunk of (store.chunks as ChunkEmbeddingV3[] | undefined) ?? []) {
    const live = liveByPageId.get(chunk.pageId);
    if (live && live.chunkContentHashes[chunk.chunkIndex] === chunk.contentHash) out.push(chunk);
    else if (live) reembed.add(chunk.pageId);
  }
  return out;
}

/** True when this chunk's (pageId,index) is unique AND its live contentHash matches. */
function isChunkPreservable(
  chunk: Record<string, unknown>,
  live: EligibleLivePage | undefined,
  pageId: PageId,
  seen: Set<string>,
): boolean {
  if (!live) return false;
  const index = chunk.chunkIndex;
  if (typeof index !== "number") return false;
  const key = `${pageId}#${index}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return live.chunkContentHashes[index] === chunk.contentHash;
}

/** Queue any eligible live page that produced no preserved page entry to re-embed. */
function addNewEligiblePages(pages: EligibleLivePage[], entries: PageEmbeddingV3[], reembed: Set<PageId>): void {
  const preserved = new Set(entries.map((e) => e.pageId));
  for (const page of pages) {
    if (!preserved.has(page.pageId)) reembed.add(page.pageId);
  }
}

/** Resolve a v2 slug to its sole eligible live pageId, or null if ambiguous/absent. */
function soleEligiblePageId(slugToPageIds: Map<string, PageId[]>, slug: unknown): PageId | null {
  if (typeof slug !== "string") return null;
  const ids = slugToPageIds.get(slug);
  return ids && ids.length === 1 ? ids[0] : null;
}

/** Recompute the embedding-input hash for a v2 page entry's title+summary. */
function hashEntryText(entry: Record<string, unknown>): string {
  const title = typeof entry.title === "string" ? entry.title : "";
  const summary = typeof entry.summary === "string" ? entry.summary : "";
  return hashChunkText(buildEmbeddingText({ title, summary }));
}

/** Project a v2 page entry onto a v3 record, re-keyed and hash-stamped. */
function toPageV3(entry: Record<string, unknown>, pageId: PageId, embeddingTextHash: string): PageEmbeddingV3 {
  return {
    pageId,
    title: entry.title as string,
    summary: (entry.summary as string) ?? "",
    embeddingTextHash,
    vector: entry.vector as number[],
    updatedAt: entry.updatedAt as string,
  };
}

/** Project a v2 chunk entry onto a v3 record, re-keyed to the qualified pageId. */
function toChunkV3(chunk: Record<string, unknown>, pageId: PageId): ChunkEmbeddingV3 {
  return {
    pageId,
    title: chunk.title as string,
    chunkIndex: chunk.chunkIndex as number,
    contentHash: chunk.contentHash as string,
    text: chunk.text as string,
    vector: chunk.vector as number[],
    updatedAt: chunk.updatedAt as string,
  };
}

/** True when the store is already v3 (idempotent path — preserve records as-is). */
function isV3(store: Record<string, unknown>): boolean {
  return store.version === 3;
}

/** Narrow an unknown field to an array (empty when absent / not an array). */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
