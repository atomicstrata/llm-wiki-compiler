/**
 * @file src/vectors/import.ts
 * @description The `vector-shards` preparation step and the vector store's
 * full verification.
 *
 * IMPORT. The authoritative incumbent store (the binary container when one
 * exists, else the JSON store) is captured ONCE within its incumbent cap and
 * parsed from exactly those bytes; it must be a valid v3 store (an older or
 * invalid one parks the step: upgrade it with a compile on the current
 * architecture first, nothing is re-embedded silently). Every vector is
 * encoded as float32 and decoded back to prove it equals `Math.fround` of the
 * original before anything is written. Pages are committed in bounded
 * batches. An import is BOUND to the exact backup it began from (path and
 * SHA-256): a rerun resumes only that one, rewriting the same rows
 * (idempotent), and any changed or vanished backup parks it; the stored row
 * counts must equal the source's before it is marked ready. Sparse chunk
 * indexes are refused explicitly. The backup is never written; its stamp is
 * re-checked after parsing. Full verification is `./verify.ts`.
 */

import { assertCaptureCurrent, captureLegacy, type LegacyCapture } from "../history/contracts.js";
import { EMBEDDINGS_FILE, MAX_EMBEDDING_STORE_BYTES } from "../utils/constants.js";
import { decodeBinaryStore, MAX_BINARY_STORE_BYTES } from "../utils/embeddings-binary.js";
import { EMBEDDINGS_BINARY_FILE, parseEmbeddingStore } from "../utils/embeddings-storage.js";
import { validateV3ForSearch, type ChunkEmbeddingV3, type EmbeddingStoreV3, type PageEmbeddingV3 } from "../utils/embeddings-store.js";
import { sortedByKey, type SegmentRow } from "../segments/contracts.js";
import type { SegmentStore } from "../segments/store.js";
import { decodeVector, encodeVector } from "./codec.js";
import { chunkVectorKey, pageMetaKey, pageVectorKey, type VectorMeta } from "./contracts.js";
import { openVectorStore, vectorMetaOf } from "./store.js";

/** Entries imported per bounded commit. */
const ENTRIES_PER_COMMIT = 1024;

/** Capture the authoritative incumbent store: the binary container when present, else the JSON store. */
async function captureIncumbent(root: string, store: SegmentStore): Promise<LegacyCapture> {
  const binary = await captureLegacy(root, EMBEDDINGS_BINARY_FILE, MAX_BINARY_STORE_BYTES, store.counters);
  return binary.body !== null ? binary : captureLegacy(root, EMBEDDINGS_FILE, MAX_EMBEDDING_STORE_BYTES, store.counters);
}

/** Parse the captured bytes as a valid v3 store, or say why it cannot be imported. */
function parseIncumbent(capture: LegacyCapture): EmbeddingStoreV3 | string | null {
  if (capture.body === null) return null;
  let parsed;
  try { parsed = parseEmbeddingStore(capture.snapshot.relPath === EMBEDDINGS_BINARY_FILE ? decodeBinaryStore(capture.body) : JSON.parse(capture.body.toString("utf8"))); } catch { return "the embedding store cannot be decoded"; }
  if (parsed === null) return "the embedding store has an unsupported format";
  if (parsed.version !== 3) return "the embedding store is an older version; run a compile on the current architecture to upgrade it first";
  const validation = validateV3ForSearch(parsed);
  if (validation.droppedIds.length > 0) return "the embedding store contains malformed page IDs; repair the source store before retrying preparation";
  if (!validation.available) return "the embedding store failed integrity validation";
  return parsed.store as unknown as EmbeddingStoreV3;
}

/** One vector encoded, proved to decode to its float32 values. */
function encodedExactly(vector: readonly number[]): string {
  const vec = encodeVector(vector);
  const back = decodeVector(vec, vector.length);
  if (back.some((value, at) => value !== Math.fround(vector[at]!))) throw new Error("a vector does not survive float32 encoding");
  return vec;
}

/** The chunk hashes of one page in index order; sparse chunk indexes are refused (explicitly unsupported). */
function denseChunkHashes(pageId: string, chunks: readonly ChunkEmbeddingV3[]): string[] {
  const ordered = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
  if (ordered.some((chunk, at) => chunk.chunkIndex !== at)) throw new Error(`page ${pageId} has sparse chunk indexes; recompute its embeddings on the current architecture first`);
  return ordered.map((chunk) => chunk.contentHash);
}

/**
 * The rows of one page: its vector (when the store has a page entry) and its
 * metadata, tagged with the incumbent store's configuration. A chunk-only page
 * gets metadata with an empty text hash, so the next refresh re-embeds it and
 * can always find its chunk rows to replace or remove.
 */
function pageImportRows(pageId: string, entry: PageEmbeddingV3 | undefined, chunks: readonly ChunkEmbeddingV3[], source: EmbeddingStoreV3): SegmentRow[] {
  const meta = { embeddingTextHash: entry?.embeddingTextHash ?? "", chunkHashes: denseChunkHashes(pageId, chunks), model: source.model, fingerprint: source.fingerprint ?? null };
  const rows: SegmentRow[] = [{ k: pageMetaKey(pageId), v: meta }];
  if (entry !== undefined) {
    const { vector, ...page } = entry;
    rows.push({ k: pageVectorKey(pageId), v: { ...page, vec: encodedExactly(vector) } });
  }
  return rows;
}

/** The rows of one chunk entry. */
function chunkImportRow(chunk: ChunkEmbeddingV3): SegmentRow {
  const { vector, ...rest } = chunk;
  return { k: chunkVectorKey(chunk.pageId, chunk.chunkIndex), v: { ...rest, vec: encodedExactly(vector) } };
}

/** Commit the incumbent store's rows in bounded batches of pages (their chunks travel with them). */
async function commitInBatches(store: SegmentStore, incumbent: EmbeddingStoreV3, meta: VectorMeta): Promise<SegmentStore> {
  const chunksOf = new Map<string, ChunkEmbeddingV3[]>();
  for (const chunk of incumbent.chunks ?? []) chunksOf.set(chunk.pageId, [...(chunksOf.get(chunk.pageId) ?? []), chunk]);
  const pageIds = [...new Set([...incumbent.entries.map((entry) => entry.pageId), ...chunksOf.keys()])].sort();
  const entryOf = new Map(incumbent.entries.map((entry) => [entry.pageId, entry]));
  let current = store;
  for (let start = 0; start < pageIds.length; start += ENTRIES_PER_COMMIT) {
    const rows = pageIds.slice(start, start + ENTRIES_PER_COMMIT).flatMap((pageId) => {
      const chunks = chunksOf.get(pageId) ?? [];
      return [...pageImportRows(pageId, entryOf.get(pageId), chunks, incumbent), ...chunks.map(chunkImportRow)];
    });
    current = await current.commit({ rows: sortedByKey(rows), meta: { ...meta, phase: "importing" } });
  }
  return current;
}

/** Before marking the import ready, the stored page and chunk rows must be exactly the source's counts. */
async function assertImportedRows(store: SegmentStore, meta: VectorMeta): Promise<void> {
  const counted = { pages: 0, chunks: 0 };
  for await (const row of store.scan({ from: "c:" })) {
    if (row.k.startsWith("c:")) counted.chunks += 1;
    else if (row.k.startsWith("p:")) counted.pages += 1;
  }
  if (counted.pages !== meta.pages || counted.chunks !== meta.chunks) throw new Error(`the imported vector rows (${counted.pages}/${counted.chunks}) do not match the source (${meta.pages}/${meta.chunks})`);
}

/** Import the incumbent embedding store of `root` into the vector store; returns a summary or throws why not. */
export async function importVectors(root: string): Promise<string> {
  const store = await openVectorStore(root);
  const capture = await captureIncumbent(root, store);
  const incumbent = parseIncumbent(capture);
  if (typeof incumbent === "string") throw new Error(incumbent);
  await assertCaptureCurrent(root, capture, store.counters);
  if (store.exists) {
    // A store already begun is bound to the exact backup it began from: resume only that one.
    const prior = vectorMetaOf(store);
    if (prior.legacy.relPath !== capture.snapshot.relPath || prior.legacy.sha256 !== capture.snapshot.sha256) {
      throw new Error(`${capture.snapshot.relPath} is not the embedding store this import began from (it changed or disappeared); restore that backup to continue`);
    }
    if (prior.phase === "ready") return `vector store already imported from ${capture.snapshot.relPath}; nothing rewritten`;
  }
  const empty: EmbeddingStoreV3 = { version: 3, model: "", dimensions: 0, entries: [], chunks: [] };
  const source = incumbent ?? empty;
  const meta: VectorMeta = {
    schema: 1, phase: "ready", model: incumbent === null ? null : source.model, fingerprint: source.fingerprint ?? null,
    dimensions: source.dimensions, pages: source.entries.length, chunks: source.chunks?.length ?? 0,
    legacy: { ...capture.snapshot, records: source.entries.length + (source.chunks?.length ?? 0) },
  };
  const written = await commitInBatches(store, source, meta);
  await assertImportedRows(written, meta);
  await written.commit({ meta: { ...meta } });
  return `imported ${meta.pages} page and ${meta.chunks} chunk embeddings as float32 pieces; ${capture.snapshot.relPath} kept untouched as a backup`;
}
