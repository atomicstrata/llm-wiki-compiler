/**
 * Binary vector I/O for embedding stores.
 *
 * When LLMWIKI_BINARY_EMBEDDINGS is set, vectors are packed into a contiguous
 * Float32 binary buffer and stored in .llmwiki/embeddings.bin instead of
 * inside the JSON store. This avoids JSON.stringify blowing past Node's
 * string-length limit (~268 MB) on wikis with many pages and chunks.
 */

import type { EmbeddingStore } from "./embeddings.js";

/**
 * Pack vectors from entries and chunks into a contiguous Float32 binary buffer.
 * Returns the buffer and a JSON-safe store with vectors stripped.
 */
export function serializeBinaryStore(store: EmbeddingStore): { store: EmbeddingStore; buffer: Buffer } {
  const allVectors: number[][] = [
    ...store.entries.map((e) => e.vector),
    ...(store.chunks ?? []).map((c) => c.vector),
  ];
  const totalFloats = allVectors.reduce((sum, v) => sum + v.length, 0);
  const buf = Buffer.allocUnsafe(totalFloats * 4);
  const floats = new Float32Array(buf.buffer, buf.byteOffset, totalFloats);
  let offset = 0;
  for (const v of allVectors) {
    floats.set(v, offset);
    offset += v.length;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const strippedEntries = store.entries.map(({ vector: _v, ...rest }: any) => rest);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const strippedChunks = store.chunks?.map(({ vector: _v, ...rest }: any) => rest);

  return {
    store: { ...store, binaryVectors: true, entries: strippedEntries, chunks: strippedChunks },
    buffer: buf,
  };
}

/**
 * Restore vectors from a contiguous binary buffer into a store whose entries
 * and chunks were stripped of their vector fields.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function deserializeBinaryStore(raw: any, buffer: Buffer): EmbeddingStore {
  const dimensions: number = raw.dimensions;
  const entryCount: number = raw.entries.length;
  const chunkCount: number = raw.chunks?.length ?? 0;
  const bytesPerVector = dimensions * 4;

  const entries = raw.entries.map((e: any, i: number) => {
    const start = i * bytesPerVector;
    const floats = new Float32Array(buffer.buffer, buffer.byteOffset + start, dimensions);
    return { ...e, vector: Array.from(floats) };
  });

  const chunks = (raw.chunks ?? []).map((c: any, i: number) => {
    const start = (entryCount + i) * bytesPerVector;
    const floats = new Float32Array(buffer.buffer, buffer.byteOffset + start, dimensions);
    return { ...c, vector: Array.from(floats) };
  });

  return { ...raw, entries, chunks: chunkCount > 0 ? chunks : undefined };
}
