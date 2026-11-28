/**
 * @file src/utils/embeddings-hits.ts
 * @description The pieces of the v3 read pipeline that BOTH the whole-store
 * finders (`./embeddings-load.ts`) and the piecewise `local-indexed` finders
 * (`../vectors/search.ts`) use: the surface flag, the hit shapes, the query
 * embedding, and the live rehydration of hits (S12: output text comes from
 * the live file, never a store's cached copy). Kept apart so neither finder
 * module imports the other.
 */

import { getEmbeddingProvider } from "./embedding-provider.js";
import { assertVectorValid } from "./embeddings-validate.js";
import type { ChunkEmbeddingV3, PageEmbeddingV3 } from "./embeddings-store.js";
import { loadPageRecordsByPageIdFrom, type LivePageReads } from "./page-registry.js";
import { splitIntoChunks } from "./retrieval.js";
import { parseQualifiedPageId, type PageId } from "./page-id.js";
import type { LoadedProfile } from "../profile/types.js";
import type { PageRecord } from "../pages/read.js";

/** Namespace→directory map resolved from the active profile (or reserved-only). */
type NamespaceDirs = Map<string, string>;

/** Which surface flag a load filters by (each surface filters independently). */
export type RetrievalSurface = "search" | "context";

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
 * Embed the query string and assert the returned vector matches the store dim.
 *
 * A non-positive `dimensions` means the store declares none — an empty store
 * written by a rebuild that had nothing to embed carries 0. Passing that through
 * would assert `vector.length === 0` and throw on every query, permanently:
 * nothing rewrites the store, so it never recovers. Treat it as UNKNOWN instead
 * and let the vector's own integrity check stand alone.
 */
export async function embedQuery(question: string, dimensions: number): Promise<number[]> {
  const vec = await getEmbeddingProvider().embed(question, "query");
  assertVectorValid(vec, dimensions > 0 ? dimensions : undefined);
  return vec;
}

/** A typed namespace's `includeInSearch`/`includeInContext` flag (tri-state). */
export function passesSurfaceFlag(pageId: PageId, surface: RetrievalSurface, profile?: LoadedProfile): boolean {
  const parsed = parseQualifiedPageId(pageId);
  if (!parsed || !profile) return true;
  const def = profile.profile.entities[parsed.namespace]?.retrieval;
  if (!def) return true;
  const flag = surface === "search" ? def.includeInSearch : def.includeInContext;
  return flag !== false;
}

/** Rehydrate a page hit's title/summary from the LIVE file, never the store (S12). */
export async function rehydratePageHit(
  pages: LivePageReads,
  entry: PageEmbeddingV3,
  score: number,
  namespaceDirs: NamespaceDirs,
): Promise<PageHitV3> {
  const slug = parseQualifiedPageId(entry.pageId)?.pagePart ?? "";
  const live = await loadLivePage(pages, entry.pageId, namespaceDirs);
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
export async function rehydrateChunkHit(
  pages: LivePageReads,
  entry: ChunkEmbeddingV3,
  score: number,
  liveContentHash: string,
  namespaceDirs: NamespaceDirs,
): Promise<ChunkHitV3> {
  const live = await loadLivePage(pages, entry.pageId, namespaceDirs);
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
  pages: LivePageReads,
  pageId: PageId,
  namespaceDirs: NamespaceDirs,
): Promise<PageRecord | null> {
  const records = await loadPageRecordsByPageIdFrom(pages.reads, [pageId], namespaceDirs);
  return records[0] ?? null;
}
