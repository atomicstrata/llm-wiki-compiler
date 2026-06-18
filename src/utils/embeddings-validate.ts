/**
 * Provider-neutral embedding response validation. Imports NOTHING from
 * provider.ts — this leaf module is depended on by both the providers and the
 * batch helper, so the provider → openai → batch → provider cycle can't form.
 * Validation functions are added in Task 8.
 */

/** Provider returned structurally invalid data (count, shape, dimension, index). */
export class EmbeddingIntegrityError extends Error {
  constructor(message: string) {
    super(`Embedding integrity error: ${message}`);
    this.name = "EmbeddingIntegrityError";
  }
}

/** Throw an integrity error unless `v` is a non-empty finite vector of expectedDim. */
export function assertVectorValid(v: unknown, expectedDim?: number): asserts v is number[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new EmbeddingIntegrityError("empty or non-array vector");
  }
  for (const n of v) {
    if (typeof n !== "number" || !Number.isFinite(n)) {
      throw new EmbeddingIntegrityError("vector contains a non-finite value");
    }
  }
  if (expectedDim !== undefined && v.length !== expectedDim) {
    throw new EmbeddingIntegrityError(`vector dimension ${v.length} !== expected ${expectedDim}`);
  }
}

/**
 * Validate every vector: each non-empty + finite, all sharing one dimension, and
 * (when expectedDim is given) equal to it.
 */
export function assertEveryVectorValid(vectors: unknown[], expectedDim?: number): asserts vectors is number[][] {
  if (vectors.length === 0) return;
  assertVectorValid(vectors[0], expectedDim);
  const dim = (vectors[0] as number[]).length;
  for (const v of vectors) assertVectorValid(v, dim);
}

/** Return true for plain non-null objects whose fields can be inspected. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/**
 * Validate an on-disk embeddings store before search or reuse. The store is
 * local mutable state, so old or hand-edited poisoned vectors must not survive
 * just because the current provider write path is stricter.
 */
export function assertEmbeddingStoreValid(store: unknown): void {
  if (!isRecord(store)) throw new EmbeddingIntegrityError("store is not an object");
  const dimensions = store.dimensions;
  if (!Number.isInteger(dimensions) || (dimensions as number) < 0) {
    throw new EmbeddingIntegrityError("store dimensions must be a non-negative integer");
  }
  if (!Array.isArray(store.entries)) throw new EmbeddingIntegrityError("store entries must be an array");
  const chunks = store.chunks;
  if (chunks !== undefined && !Array.isArray(chunks)) {
    throw new EmbeddingIntegrityError("store chunks must be an array when present");
  }
  const vectors = [...store.entries, ...((chunks as unknown[] | undefined) ?? [])];
  if (vectors.length > 0 && dimensions === 0) {
    throw new EmbeddingIntegrityError("store dimensions is 0 but vectors are present");
  }
  for (const item of vectors) {
    if (!isRecord(item)) throw new EmbeddingIntegrityError("store entry is not an object");
    assertVectorValid(item.vector, dimensions as number);
  }
}

/** Fill output slots by explicit index field; throws on out-of-range or duplicate index. */
function fillIndexedSlots(
  data: Array<{ index?: number; embedding?: unknown }>,
  out: (number[] | undefined)[],
  n: number,
): void {
  for (const d of data) {
    const i = d.index as number;
    if (!Number.isInteger(i) || i < 0 || i >= n) {
      throw new EmbeddingIntegrityError(`response index out of range: ${i}`);
    }
    if (out[i] !== undefined) {
      throw new EmbeddingIntegrityError(`duplicate response index: ${i}`);
    }
    assertVectorValid(d.embedding);
    out[i] = d.embedding as number[];
  }
}

/** Fill output slots in positional order (no index field present). */
function fillPositionalSlots(
  data: Array<{ index?: number; embedding?: unknown }>,
  out: (number[] | undefined)[],
  n: number,
): void {
  for (let i = 0; i < n; i++) {
    assertVectorValid(data[i].embedding);
    out[i] = data[i].embedding as number[];
  }
}

/** Throw if any slot is still unfilled (explicit loop avoids sparse-hole blindspot). */
function assertAllSlotsFilled(out: (number[] | undefined)[], n: number): void {
  for (let i = 0; i < n; i++) {
    if (out[i] === undefined) throw new EmbeddingIntegrityError(`response did not fill slot ${i}`);
  }
}

/**
 * Validate that every response item is a non-null object and return how many
 * carry an `index`. Done before any field access so a malformed item (e.g.
 * `null`) is classified as an integrity error, not a raw TypeError (unknown).
 */
function countIndexedItems(data: Array<{ index?: number; embedding?: unknown }>): number {
  let indexed = 0;
  for (const d of data) {
    if (d === null || typeof d !== "object") {
      throw new EmbeddingIntegrityError("response item is not an object");
    }
    if (d.index !== undefined) indexed++;
  }
  return indexed;
}

/**
 * Reorder provider response items into input order and validate each embedding.
 * OpenAI/Voyage return `{ index, embedding }`. Rules:
 *   - cardinality must equal n;
 *   - either ALL items carry a numeric index or NONE do (mixed → corruption);
 *   - indexed: every index is an integer in [0, n), unique, and fills every slot;
 *   - each embedding is a non-empty finite vector.
 * Uses an explicit 0..n-1 fill check (NOT Array.prototype.some, which skips
 * sparse holes) so a missing slot is always caught.
 */
export function normalizeEmbeddingData(
  data: Array<{ index?: number; embedding?: unknown }>,
  n: number,
): number[][] {
  if (!Array.isArray(data) || data.length !== n) {
    throw new EmbeddingIntegrityError(`cardinality: got ${data?.length} vectors for ${n} inputs`);
  }
  const indexed = countIndexedItems(data);
  if (indexed !== 0 && indexed !== n) {
    throw new EmbeddingIntegrityError("mixed indexed/unindexed response items");
  }

  const out: (number[] | undefined)[] = new Array(n);
  if (indexed === n) fillIndexedSlots(data, out, n);
  else fillPositionalSlots(data, out, n);
  assertAllSlotsFilled(out, n);
  return out as number[][];
}
