/**
 * Bounded pretty-JSON serialization for embedding stores. Large stores select
 * the binary format instead of first constructing an unbounded vector string.
 */
import type { EmbeddingStore, EmbeddingStoreV3 } from "./embeddings-store.js";
import { MAX_EMBEDDING_STORE_BYTES } from "./constants.js";

/** Only JSON serialization failure, never filesystem or binary allocation failure. */
class JsonSizeError extends Error {}

/** Translate only stringify's string-size ceiling into format selection. */
function stringify(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2);
    if (text === undefined) throw new TypeError("embedding metadata is not JSON serializable");
    return text;
  } catch (err) {
    if (err instanceof RangeError) throw new JsonSizeError();
    throw err;
  }
}

/** Yield one record at a time at the indentation used by legacy JSON output. */
function* recordSegments(records: unknown[]): Generator<string> {
  if (records.length === 0) { yield "[]"; return; }
  yield "[\n";
  for (let index = 0; index < records.length; index++) {
    if (index > 0) yield ",\n";
    yield stringify(records[index]).replace(/^/gm, "    ");
  }
  yield "\n  ]";
}

/** Shallow store assembly leaves nested record serialization to the JSON engine. */
function* storeSegments(store: object): Generator<string> {
  yield "{";
  let count = 0;
  for (const [key, value] of Object.entries(store)) {
    if (value === undefined) continue;
    yield count++ === 0 ? "\n" : ",\n";
    yield `  ${stringify(key)}: `;
    if ((key === "entries" || key === "chunks") && Array.isArray(value)) yield* recordSegments(value);
    else yield stringify(value).replace(/\n/g, "\n  ");
  }
  yield count > 0 ? "\n}" : "}";
}

/** Return the legacy JSON bytes when they fit, otherwise request binary storage. */
export function serializeEmbeddingJson(
  store: EmbeddingStore | EmbeddingStoreV3 | Record<string, unknown>,
  maxBytes = MAX_EMBEDDING_STORE_BYTES,
): string | null {
  const segments: string[] = [];
  let size = 0;
  try {
    for (const segment of storeSegments(store)) {
      size += Buffer.byteLength(segment, "utf8");
      if (size > maxBytes) return null;
      segments.push(segment);
    }
  } catch (err) {
    if (err instanceof JsonSizeError) return null;
    throw err;
  }
  const serialized = segments.join("");
  return Buffer.byteLength(serialized, "utf8") <= maxBytes ? serialized : null;
}
