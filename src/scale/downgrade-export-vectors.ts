/**
 * @file src/scale/downgrade-export-vectors.ts
 * @description The scale-down EXPORT of an active `local-indexed` project's
 * piecewise vector store into the incumbent BINARY embedding container
 * (`.llmwiki/embeddings.bin`), for either smaller layout: `local-large`
 * selects that container for every write, and `local-standard` keeps an
 * existing binary container authoritative, so both serve it unchanged.
 *
 * EXACT FLOAT32. The stored vectors are already little-endian float32 bytes
 * (base64 in each row), which is exactly the container's payload encoding,
 * so they are copied, never re-rounded: the exported container holds the
 * very values the indexed store searched. Values the incumbent JSON store
 * held at double precision before the project became indexed are NOT
 * restored; they were rounded to float32 at that preparation.
 *
 * STREAMED. The metadata (every record without its vector) is built first,
 * bounded by the container's own size cap; then the payload streams record by
 * record (page entries, then chunks, each in key order). A store that is
 * REBUILDING under a new embedding configuration holds mixed identities and
 * is refused (`downgrade_export_unsupported`); a store whose records exceed
 * the container's entry or byte limits is refused (`downgrade_export_too_large`).
 */

import { MAX_EMBEDDING_ENTRIES } from "../utils/constants.js";
import { encodeBinaryPrefix, MAX_BINARY_STORE_BYTES } from "../utils/embeddings-binary.js";
import { EMBEDDINGS_BINARY_FILE } from "../utils/embeddings-storage.js";
import type { SegmentStore } from "../segments/store.js";
import { asChunkVectorRow, asPageVectorRow, decodeVector } from "../vectors/codec.js";
import type { VectorMeta } from "../vectors/contracts.js";
import { openVectorStore, readyVectorMeta } from "../vectors/store.js";
import { DowngradeExportError, type ExportedFile } from "./downgrade-sink.js";
import type { SinkFactory } from "./downgrade-export-history.js";

/** The row prefixes of page entries and chunks, in the container's record order. */
const PAGE_ROWS = "p:";
const CHUNK_ROWS = "c:";

/** One stored row without its vector, as the container's metadata lists it. */
type MetadataRecord = Record<string, unknown>;

/** Validate one stored row of `prefix` under `key`. */
function rowOf(prefix: string, value: unknown, key: string): { vec: string } & MetadataRecord {
  return (prefix === PAGE_ROWS ? asPageVectorRow(value, key) : asChunkVectorRow(value, key)) as unknown as { vec: string } & MetadataRecord;
}

/** Every row of `prefix` without its vector, refusing once the metadata alone would exceed the container cap. */
async function metadataOf(store: SegmentStore, prefix: string, budget: { bytes: number }): Promise<MetadataRecord[]> {
  const records: MetadataRecord[] = [];
  for await (const row of store.scan({ prefix })) {
    const { vec: _vec, ...metadata } = rowOf(prefix, row.v, row.k);
    budget.bytes += Buffer.byteLength(JSON.stringify(metadata));
    if (budget.bytes > MAX_BINARY_STORE_BYTES) throw new DowngradeExportError("downgrade_export_too_large", `the embedding metadata exceeds the ${MAX_BINARY_STORE_BYTES}-byte container cap`);
    records.push(metadata);
  }
  return records;
}

/** The container metadata: the v3 store shape with every vector removed. */
async function containerMetadata(store: SegmentStore, meta: VectorMeta): Promise<Record<string, unknown>> {
  const budget = { bytes: 0 };
  const entries = await metadataOf(store, PAGE_ROWS, budget);
  const chunks = await metadataOf(store, CHUNK_ROWS, budget);
  if (entries.length !== meta.pages || chunks.length !== meta.chunks) {
    throw new DowngradeExportError("downgrade_export_mismatch", `the vector store holds ${entries.length}/${chunks.length} rows, its manifest records ${meta.pages}/${meta.chunks}`);
  }
  return { version: 3, model: meta.model, ...(meta.fingerprint === null ? {} : { fingerprint: meta.fingerprint }), dimensions: meta.dimensions, entries, chunks };
}

/** Stream the float32 payload of every row of `prefix`, in key order; returns how many. */
async function pushVectors(store: SegmentStore, prefix: string, dimensions: number, push: (bytes: Buffer) => Promise<void>): Promise<number> {
  let records = 0;
  for await (const row of store.scan({ prefix })) {
    const { vec } = rowOf(prefix, row.v, row.k);
    // Decoding validates the length and finiteness; the canonical base64 bytes ARE the little-endian payload.
    decodeVector(vec, dimensions);
    await push(Buffer.from(vec, "base64"));
    records += 1;
  }
  return records;
}

/** Refuse a store the binary container cannot represent before anything is streamed. */
function assertRepresentable(meta: VectorMeta): void {
  if (meta.phase === "rebuilding") throw new DowngradeExportError("downgrade_export_unsupported", "the vector store is rebuilding under a new embedding configuration (mixed identities); finish the refresh first");
  if (meta.pages + meta.chunks > MAX_EMBEDDING_ENTRIES) {
    throw new DowngradeExportError("downgrade_export_too_large", `${meta.pages} page and ${meta.chunks} chunk embeddings exceed the container's ${MAX_EMBEDDING_ENTRIES} entries`);
  }
}

/** Export the vector store of `root` as `.llmwiki/embeddings.bin`; absent when nothing was ever embedded. */
export async function exportVectors(root: string, sinkFor: SinkFactory): Promise<ExportedFile> {
  const sink = sinkFor(EMBEDDINGS_BINARY_FILE, MAX_BINARY_STORE_BYTES);
  const store = await openVectorStore(root);
  const meta = readyVectorMeta(store);
  if (meta.model === null) return sink.absent();
  assertRepresentable(meta);
  const prefix = encodeBinaryPrefix(await containerMetadata(store, meta));
  if (prefix === null) throw new DowngradeExportError("downgrade_export_too_large", "the embedding metadata exceeds the container's metadata limit");
  await sink.push(prefix);
  /** Hand one record's float32 payload to the sink. */
  const push = (bytes: Buffer) => sink.push(bytes);
  const records = await pushVectors(store, PAGE_ROWS, meta.dimensions, push) + await pushVectors(store, CHUNK_ROWS, meta.dimensions, push);
  if (records !== meta.pages + meta.chunks) throw new DowngradeExportError("downgrade_export_mismatch", "the vector rows changed while they were exported");
  return sink.finish(records);
}
