/**
 * @file src/vectors/search.ts
 * @description EXACT top-K search over the piecewise vector store with a
 * BOUNDED resident set: rows stream one verified block per run at a time,
 * and only the K best FRESH candidates (lightweight records, never the
 * vectors) are held. K is normalized to a finite integer in 1..1000 first;
 * a non-positive or non-numeric K answers nothing without any I/O.
 *
 * The incumbent pipeline ranks every eligible entry, then walks the ranking
 * until it has K fresh hits, so a stale high scorer never crowds out a fresh
 * lower one. Here a candidate is checked for liveness and freshness WHEN it
 * would enter the top K (one live read each, counted), and only fresh ones
 * enter; the result is the same K fresh entries in the same order, with the
 * incumbent tie rule (score descending, then the qualified id compared by
 * `localeCompare`). A candidate whose page is not live is dropped silently,
 * as the incumbent prefilter drops it; a live but changed one is reported
 * stale when it ranks above the K-th hit (a bounded sample).
 *
 * The query is embedded LAZILY, only once a candidate is in scope, passes its
 * surface flag and is live, so (like the incumbent) a store with no live
 * eligible candidate costs no provider call. Each hit is RE-VALIDATED
 * immediately before it is returned. One that changed after admission is
 * reported stale and dropped when the top K was never full (every fresh
 * candidate was kept, so the shorter result is still exact); when it was
 * full, lower candidates were discarded and the exact fresh K is no longer
 * known, so the search REJECTS with {@link VectorSearchChangedError}, which
 * the callers' existing embedding-failure policy handles (fallback with a
 * warning, or `throw`). Reads are not one atomic snapshot of the files: only
 * this admission-then-revalidation is promised. The cost is an exact
 * O(stored vectors) scan; there is no approximate index.
 */

import type { LoadedProfile } from "../profile/types.js";
import type { PageId } from "../utils/page-id.js";
import { buildNamespaceDirs, readLiveContentHashesFrom, type LiveContentHashes, type LivePageReads } from "../utils/page-registry.js";
import {
  embedQuery, passesSurfaceFlag, rehydrateChunkHit, rehydratePageHit, type ChunkHitV3, type PageHitV3, type RetrievalSurface,
} from "../utils/embeddings-hits.js";
import type { ChunkEmbeddingV3, PageEmbeddingV3 } from "../utils/embeddings-store.js";
import { asChunkVectorRow, asPageVectorRow, cosineFloat32, decodeVector } from "./codec.js";
import type { ShardedVectorView } from "./store.js";

/** The namespace directory map the incumbent registry reads take. */
type NamespaceDirs = ReturnType<typeof buildNamespaceDirs>;

/** Stale candidates kept for the report, at most. */
const STALE_SAMPLE = 64;
/** Largest K a search holds. */
const MAX_TOP_K = 1000;

/** K as a finite integer in 1..MAX_TOP_K, or 0 (answer nothing) for anything non-positive or non-numeric. */
function normalizedTopK(k: number): number {
  if (typeof k !== "number" || Number.isNaN(k) || k < 1) return 0;
  return Math.min(Math.floor(k), MAX_TOP_K);
}

/** A hit changed during a search whose top K was full, so the exact fresh top K is unknown; retry the search. */
export class VectorSearchChangedError extends Error {
  constructor() {
    super("pages changed during semantic search, so its exact top results are unknown; retry the search");
    this.name = "VectorSearchChangedError";
  }
}

/** One ranked candidate. */
interface Ranked<E> { readonly entry: E; readonly score: number; readonly tie: string }

/** Whether `a` ranks before `b`: score descending, then the incumbent tie key. */
function ranksBefore(a: Ranked<unknown>, b: Ranked<unknown>): boolean {
  return a.score !== b.score ? a.score > b.score : a.tie.localeCompare(b.tie) < 0;
}

/** Insert `item` into the ranked list `list`, keeping at most `max` best. */
function insertRanked<E>(list: Array<Ranked<E>>, item: Ranked<E>, max: number): void {
  let at = list.length;
  while (at > 0 && ranksBefore(item, list[at - 1]!)) at -= 1;
  list.splice(at, 0, item);
  if (list.length > max) list.pop();
}

/** The scan's state: the fresh top K and the best stale candidates. */
class TopFresh<E> {
  readonly hits: Array<Ranked<E>> = [];
  readonly stale: Array<Ranked<PageId>> = [];

  constructor(readonly k: number) {}

  /** Whether a candidate could still enter the top K. */
  admits(item: Ranked<unknown>): boolean {
    return this.hits.length < this.k || ranksBefore(item, this.hits[this.k - 1]!);
  }

  /** Note a stale candidate. */
  noteStale(item: Ranked<{ pageId: PageId }>): void {
    insertRanked(this.stale, { entry: item.entry.pageId, score: item.score, tie: item.tie }, STALE_SAMPLE);
  }

  /** The stale page ids ranked above the K-th fresh hit, in rank order. */
  stalePageIds(): PageId[] {
    const floor = this.hits.length === this.k ? this.hits[this.k - 1]! : undefined;
    return this.stale.filter((item) => floor === undefined || ranksBefore(item, floor)).map((item) => item.entry);
  }
}

/** One scan's inputs; the query is embedded lazily. */
class Scan {
  private query: number[] | null = null;
  readonly dirs: NamespaceDirs;

  constructor(readonly pages: LivePageReads, readonly view: ShardedVectorView, readonly surface: RetrievalSurface, private readonly question: string, readonly profile?: LoadedProfile) {
    this.dirs = buildNamespaceDirs(profile?.profile);
  }

  /** Whether a stored entry is in scope and passes its surface flag. */
  eligible(pageId: PageId): boolean {
    return (this.view.scope === undefined || this.view.scope.has(pageId)) && passesSurfaceFlag(pageId, this.surface, this.profile);
  }

  /** One live freshness read, counted. */
  live(pageId: PageId): Promise<LiveContentHashes | null> {
    this.view.store.counters.bodiesRead += 1;
    return readLiveContentHashesFrom(this.pages.reads, pageId, this.dirs);
  }

  /** The query vector, embedded on first use only after a live eligible candidate exists. */
  async queryFor(pageId: PageId): Promise<number[] | null> {
    if (this.query !== null) return this.query;
    if ((await this.live(pageId)) === null) return null;
    this.query = await embedQuery(this.question, this.view.meta.dimensions);
    return this.query;
  }
}

/** Offer one stored candidate: score it once a query exists, verify it only if it could enter the top K. */
async function offer<E extends { pageId: PageId }>(scan: Scan, top: TopFresh<E>, entry: E, vec: string, tie: string, fresh: (live: LiveContentHashes) => boolean): Promise<void> {
  if (!scan.eligible(entry.pageId)) return;
  const query = await scan.queryFor(entry.pageId);
  if (query === null) return;
  const item = { entry, score: cosineFloat32(query, decodeVector(vec, scan.view.meta.dimensions)), tie };
  if (!top.admits(item)) return;
  const live = await scan.live(entry.pageId);
  if (live === null) return;
  if (fresh(live)) insertRanked(top.hits, item, top.k);
  else top.noteStale(item);
}

/** Re-validate each admitted hit immediately before returning it; a raced-out one is dropped, or rejects when the top K was full. */
async function revalidated<E extends { pageId: PageId }>(scan: Scan, top: TopFresh<E>, fresh: (entry: E, live: LiveContentHashes) => boolean): Promise<{ kept: Array<Ranked<E>>; stale: PageId[] }> {
  const kept: Array<Ranked<E>> = [];
  const stale = top.stalePageIds();
  for (const item of top.hits) {
    const live = await scan.live(item.entry.pageId);
    if (live !== null && fresh(item.entry, live)) kept.push(item);
    else stale.push(item.entry.pageId);
  }
  if (kept.length < top.hits.length && top.hits.length === top.k) throw new VectorSearchChangedError();
  return { kept, stale };
}

/** The K freshest best page hits (live-rehydrated) and the stale ids ranked above them. */
export async function findRelevantPagesSharded(
  pages: LivePageReads, view: ShardedVectorView, surface: RetrievalSurface, question: string, k: number, profile?: LoadedProfile,
): Promise<{ hits: PageHitV3[]; stalePageIds: PageId[] }> {
  const size = normalizedTopK(k);
  if (size === 0 || view.meta.pages === 0) return { hits: [], stalePageIds: [] };
  const scan = new Scan(pages, view, surface, question, profile);
  const top = new TopFresh<PageEmbeddingV3>(size);
  const isFresh = (entry: PageEmbeddingV3, live: LiveContentHashes) => live.embeddingTextHash === entry.embeddingTextHash;
  for await (const row of view.store.scan({ prefix: "p:" })) {
    const stored = asPageVectorRow(row.v, row.k);
    const entry = { pageId: stored.pageId, title: stored.title, summary: stored.summary, embeddingTextHash: stored.embeddingTextHash, updatedAt: stored.updatedAt, vector: [] };
    await offer(scan, top, entry, stored.vec, stored.pageId, (live) => isFresh(entry, live));
  }
  const { kept, stale } = await revalidated(scan, top, isFresh);
  const hits = await Promise.all(kept.map((item) => rehydratePageHit(pages, item.entry, item.score, scan.dirs)));
  return { hits, stalePageIds: stale };
}

/** The K freshest best chunk hits (live-rehydrated) and the stale ids ranked above them. */
export async function findRelevantChunksSharded(
  pages: LivePageReads, view: ShardedVectorView, surface: RetrievalSurface, question: string, k: number, profile?: LoadedProfile,
): Promise<{ hits: ChunkHitV3[]; stalePageIds: PageId[] }> {
  const size = normalizedTopK(k);
  if (size === 0 || view.meta.chunks === 0) return { hits: [], stalePageIds: [] };
  const scan = new Scan(pages, view, surface, question, profile);
  const top = new TopFresh<ChunkEmbeddingV3>(size);
  const isFresh = (entry: ChunkEmbeddingV3, live: LiveContentHashes) => live.chunkHashes[entry.chunkIndex] === entry.contentHash;
  for await (const row of view.store.scan({ prefix: "c:" })) {
    const stored = asChunkVectorRow(row.v, row.k);
    const entry = { pageId: stored.pageId, title: stored.title, chunkIndex: stored.chunkIndex, contentHash: stored.contentHash, text: stored.text, updatedAt: stored.updatedAt, vector: [] };
    await offer(scan, top, entry, stored.vec, `${stored.pageId}#${stored.chunkIndex}`, (live) => isFresh(entry, live));
  }
  const { kept, stale } = await revalidated(scan, top, isFresh);
  const hits = await Promise.all(kept.map((item) => rehydrateChunkHit(pages, item.entry, item.score, item.entry.contentHash, scan.dirs)));
  return { hits, stalePageIds: stale };
}
