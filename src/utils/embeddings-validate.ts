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
  const indexed = data.filter((d) => d.index !== undefined).length;
  if (indexed !== 0 && indexed !== n) {
    throw new EmbeddingIntegrityError("mixed indexed/unindexed response items");
  }

  const out: (number[] | undefined)[] = new Array(n);

  if (indexed === n) {
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
  } else {
    for (let i = 0; i < n; i++) {
      assertVectorValid(data[i].embedding);
      out[i] = data[i].embedding as number[];
    }
  }

  for (let i = 0; i < n; i++) {
    if (out[i] === undefined) throw new EmbeddingIntegrityError(`response did not fill slot ${i}`);
  }
  return out as number[][];
}
