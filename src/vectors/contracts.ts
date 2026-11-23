/**
 * @file src/vectors/contracts.ts
 * @description The PIECEWISE VECTOR STORE of a `local-indexed` project: the
 * v3 page and chunk embeddings as independently readable rows of one segment
 * store, plus a light per-page metadata row, so a refresh detects changes
 * WITHOUT loading vectors and rewrites only the rows of the pages it touches.
 *
 * KEYS (structured, unambiguous: a page id never contains NUL):
 * - `p:<pageId>`              → one page embedding (`PageEmbeddingV3` minus
 *   `vector`, plus `vec`: the vector as little-endian float32, base64);
 * - `c:<pageId>\0<index>`     → one chunk embedding (index zero-padded to 6
 *   digits, so chunk order is numeric);
 * - `m:<pageId>`              → the page's text hash, chunk content hashes and
 *   the embedding configuration (model, fingerprint) its vectors came from.
 *
 * DESIGN ADJUSTMENT (recorded): pieces are base64 float32 rows in bounded
 * segments (one verified block of at most 64 KiB resident per run while
 * scanning) rather than separate binary shard files; bytes on disk are about
 * 4/3 of raw float32, and merges retain their inputs.
 *
 * Vectors are kept with FLOAT32 semantics, the existing binary container's
 * semantics; scores are computed on those values. The incumbent JSON or
 * binary store is imported once and then kept untouched as a backup; it is
 * never read again by an indexed project, and never as a fallback.
 */

import type { PageId } from "../utils/page-id.js";
import type { LegacySnapshot } from "../history/contracts.js";

/** The vector store's segment store name. */
export const VECTORS_STORE = "vectors";

/** Rows of one vector segment are larger; a segment holds up to this much row data. */
export const VECTOR_SEGMENT_BYTES = 4 * 1024 * 1024;

/** Digits of a chunk index in its key. */
const CHUNK_INDEX_DIGITS = 6;

/** The page-embedding row key of `pageId`. */
export function pageVectorKey(pageId: string): string {
  return `p:${pageId}`;
}

/** The chunk-embedding row key of `(pageId, chunkIndex)`. */
export function chunkVectorKey(pageId: string, chunkIndex: number): string {
  return `c:${pageId}\u0000${String(chunkIndex).padStart(CHUNK_INDEX_DIGITS, "0")}`;
}

/** The metadata row key of `pageId`. */
export function pageMetaKey(pageId: string): string {
  return `m:${pageId}`;
}

/** A stored page embedding. */
export interface PageVectorRow {
  readonly pageId: PageId;
  readonly title: string;
  readonly summary: string;
  readonly embeddingTextHash: string;
  readonly updatedAt: string;
  readonly vec: string;
}

/** A stored chunk embedding. */
export interface ChunkVectorRow {
  readonly pageId: PageId;
  readonly title: string;
  readonly chunkIndex: number;
  readonly contentHash: string;
  readonly text: string;
  readonly updatedAt: string;
  readonly vec: string;
}

/** A page's change-detection facts, including the configuration its vectors came from. */
export interface PageMetaRow {
  readonly embeddingTextHash: string;
  readonly chunkHashes: readonly string[];
  readonly model: string;
  readonly fingerprint: string | null;
}

/** The vector store's manifest facts. */
export interface VectorMeta {
  readonly schema: 1;
  /**
   * `rebuilding` while a refresh under a NEW embedding configuration has
   * published some pages but not all: readers degrade (no mixed-identity
   * search) and the next refresh resumes it, page by page.
   */
  readonly phase: "importing" | "ready" | "rebuilding";
  /** Embedding model of the stored vectors, or null before anything was embedded. */
  readonly model: string | null;
  readonly fingerprint: string | null;
  readonly dimensions: number;
  readonly pages: number;
  readonly chunks: number;
  /** The incumbent store imported at preparation (JSON or binary leaf), kept as a backup. */
  readonly legacy: LegacySnapshot;
}
