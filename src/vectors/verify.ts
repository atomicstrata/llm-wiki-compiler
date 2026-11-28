/**
 * @file src/vectors/verify.ts
 * @description FULL verification of the piecewise vector store: explicit,
 * cold, O(stored vectors) work.
 *
 * Besides segment digests and the backup's bytes, it checks that the three
 * row families agree, PAGE BY PAGE, in ONE streaming merge-join (bounded
 * memory: one row of each family at a time, no repeated scans). Page ids
 * order the same way under every family's key (`m:<id>`, `p:<id>`,
 * `c:<id>\0<index>`; NUL sorts below any id character), so three key-ordered
 * scans advance together:
 *
 * - every `m:` change-detection row is well formed; on a `ready` store its
 *   configuration is the store's (mid-rebuild, pages of the old configuration
 *   are expected and their vectors may have the old length);
 * - a page has a `p:` vector exactly when its metadata carries a text hash,
 *   and that vector's hash is the metadata's;
 * - its `c:` rows are exactly indexes `0..n-1` of the metadata's chunk
 *   hashes, each carrying its hash;
 * - no `p:` or `c:` row exists without metadata, and the stored counts equal
 *   the manifest's.
 *
 * Whatever any scan throws, the lookahead scans are closed (releasing their
 * segment handles) before the original error propagates.
 */

import { legacyBytesUnchanged, legacyDriftMessage, ProblemSample } from "../history/contracts.js";
import type { HistoryVerification } from "../history/events-read.js";
import type { SegmentRow } from "../segments/contracts.js";
import type { SegmentStore } from "../segments/store.js";
import { withCountedReads } from "../segments/verification-cache.js";
import { storageOf, verifyStore } from "../segments/verify.js";
import { EMBEDDINGS_BINARY_FILE, MAX_EMBEDDING_STORE_BYTES } from "../utils/constants.js";
import { MAX_BINARY_STORE_BYTES } from "../utils/embeddings-binary.js";
import { asChunkVectorRow, asPageMetaRow, asPageVectorRow, decodeVector } from "./codec.js";
import type { PageMetaRow, VectorMeta } from "./contracts.js";
import { openVectorStore, readyVectorMeta } from "./store.js";

/** A one-row lookahead over a key-ordered scan. */
class Lookahead {
  private readonly rows: AsyncIterator<SegmentRow>;
  private pending: SegmentRow | null | undefined;

  constructor(rows: AsyncIterable<SegmentRow>) { this.rows = rows[Symbol.asyncIterator](); }

  /** The next row without consuming it, or `null` at the end. */
  async peek(): Promise<SegmentRow | null> {
    if (this.pending === undefined) {
      const next = await this.rows.next();
      this.pending = next.done === true ? null : next.value;
    }
    return this.pending;
  }

  /** Consume the row `peek` returned. */
  take(): void { this.pending = undefined; }

  /** End the scan early, closing every segment handle it holds; a close failure never replaces the caller's error. */
  async close(): Promise<void> {
    await this.rows.return?.(undefined).catch(() => {});
  }
}

/** The page id a `p:`, `m:` or `c:` key belongs to. */
function ownerOf(key: string): string {
  const cut = key.indexOf("\u0000");
  return cut === -1 ? key.slice(2) : key.slice(2, cut);
}

/** Consume `rows` through `pageId`'s (all of them when `pageId` is null), handing each to `visit` with whether `pageId` owns it. */
async function consumeThrough(rows: Lookahead, pageId: string | null, visit: (row: SegmentRow, owned: boolean) => void): Promise<void> {
  for (let row = await rows.peek(); row !== null; row = await rows.peek()) {
    const owner = ownerOf(row.k);
    if (pageId !== null && owner > pageId) return;
    rows.take();
    visit(row, owner === pageId);
  }
}

/** Whether a page's configuration is the store's (an absent fingerprint on either side is not a conflict). */
function sameConfiguration(config: PageMetaRow, meta: VectorMeta): boolean {
  return config.model === meta.model && (config.fingerprint === meta.fingerprint || config.fingerprint === null || meta.fingerprint === null);
}

/** One audit's state: the problems found and the rows counted. */
class VectorAudit {
  readonly problems = new ProblemSample();
  readonly counted = { pages: 0, chunks: 0 };

  constructor(readonly meta: VectorMeta) {}

  /** Run one check, noting (not propagating) what it throws. */
  guard<T>(check: () => T): T | null {
    try { return check(); } catch (error) { this.problems.note(error instanceof Error ? error.message : String(error)); return null; }
  }

  /** The length a page's vectors must have: the store's, or any consistent length for an old-configuration page mid-rebuild. */
  dimensionsFor(config: PageMetaRow | null): number {
    return config !== null && this.meta.phase === "rebuilding" && !sameConfiguration(config, this.meta) ? 0 : this.meta.dimensions;
  }

  /** Check one `p:` row against its page's metadata (`null` when it has none). */
  pageVector(row: SegmentRow, config: PageMetaRow | null, owned: boolean): void {
    this.counted.pages += 1;
    if (!owned) this.problems.note(`page vector ${row.k.slice(0, 80)} has no metadata row`);
    this.guard(() => {
      const stored = asPageVectorRow(row.v, row.k);
      decodeVector(stored.vec, this.dimensionsFor(config));
      if (config !== null && stored.embeddingTextHash !== config.embeddingTextHash) this.problems.note(`page vector ${stored.pageId} does not carry its metadata's text hash`);
    });
  }

  /** Check one `c:` row; `expected` is the index it must have under its page's metadata. */
  chunkVector(row: SegmentRow, config: PageMetaRow | null, expected: number | null): void {
    this.counted.chunks += 1;
    if (expected === null) this.problems.note(`chunk vector ${row.k.slice(0, 80)} has no metadata row`);
    this.guard(() => {
      const stored = asChunkVectorRow(row.v, row.k);
      decodeVector(stored.vec, this.dimensionsFor(config));
      if (config === null || expected === null) return;
      if (stored.chunkIndex !== expected || config.chunkHashes[expected] !== stored.contentHash) this.problems.note(`chunk vector ${stored.pageId}#${stored.chunkIndex} does not match its metadata's chunk ${expected}`);
    });
  }

  /** Check one page: its metadata row, then its page and chunk rows (and any orphans ordered before it). */
  async page(metaRow: SegmentRow, pages: Lookahead, chunks: Lookahead): Promise<void> {
    const pageId = metaRow.k.slice(2);
    const config = this.guard(() => asPageMetaRow(metaRow.v));
    if (config !== null && this.meta.phase === "ready" && !sameConfiguration(config, this.meta)) this.problems.note(`page ${pageId} has vectors from another embedding configuration`);
    let pageRows = 0;
    await consumeThrough(pages, pageId, (row, owned) => { if (owned) pageRows += 1; this.pageVector(row, owned ? config : null, owned); });
    let next = 0;
    await consumeThrough(chunks, pageId, (row, owned) => { this.chunkVector(row, owned ? config : null, owned ? next : null); if (owned) next += 1; });
    if (config === null) return;
    if (next !== config.chunkHashes.length) this.problems.note(`page ${pageId} has ${next} chunk vectors, its metadata names ${config.chunkHashes.length}`);
    if (pageRows !== (config.embeddingTextHash === "" ? 0 : 1)) this.problems.note(`page ${pageId} has ${pageRows} page vectors for its metadata`);
  }

  /** Report the page and chunk rows left after the last metadata row, and count mismatches. */
  async finish(pages: Lookahead, chunks: Lookahead): Promise<void> {
    await consumeThrough(pages, null, (row) => this.pageVector(row, null, false));
    await consumeThrough(chunks, null, (row) => this.chunkVector(row, null, null));
    const { pages: storedPages, chunks: storedChunks } = this.counted;
    if (storedPages !== this.meta.pages || storedChunks !== this.meta.chunks) this.problems.note(`the manifest counts ${this.meta.pages}/${this.meta.chunks} pages/chunks, ${storedPages}/${storedChunks} are stored`);
  }
}

/** Full verification of the vector store of `root`: digests, every row, row-family coherence, counts, backup bytes. */
export async function verifyVectors(root: string): Promise<HistoryVerification> {
  return withCountedReads(await openVectorStore(root), (store) => verifyVectorStore(root, store));
}

/** {@link verifyVectors} over one (physically counted) snapshot. */
async function verifyVectorStore(root: string, store: SegmentStore): Promise<HistoryVerification> {
  const audit = new VectorAudit(readyVectorMeta(store));
  const pages = new Lookahead(store.scan({ prefix: "p:" }));
  const chunks = new Lookahead(store.scan({ prefix: "c:" }));
  try {
    for await (const row of store.scan({ prefix: "m:" })) await audit.page(row, pages, chunks);
    await audit.finish(pages, chunks);
  } finally {
    // A failure in any family's scan must not leave the other two scans' segment handles open.
    await pages.close();
    await chunks.close();
  }
  const storage = storageOf(await verifyStore(store));
  const legacy = audit.meta.legacy;
  const cap = legacy.relPath === EMBEDDINGS_BINARY_FILE ? MAX_BINARY_STORE_BYTES : MAX_EMBEDDING_STORE_BYTES;
  if (!(await legacyBytesUnchanged(root, legacy, cap))) audit.problems.note(legacyDriftMessage(legacy));
  const { problems, counted } = audit;
  return { ok: problems.count === 0, records: counted.pages + counted.chunks, problemCount: problems.count, problems: problems.sample, storage };
}
