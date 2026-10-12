/** Optional requested vector size, shared by request construction and index identity. */
export function resolveEmbeddingDimensions(): number | undefined {
  const raw = process.env.LLMWIKI_EMBEDDING_DIMENSIONS?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("LLMWIKI_EMBEDDING_DIMENSIONS must be a positive integer");
  }
  return value;
}

/** Refuse an endpoint that ignored the requested vector size. */
export function assertRequestedEmbeddingDimensions(vector: readonly number[]): void {
  const requested = resolveEmbeddingDimensions();
  if (requested !== undefined && vector.length !== requested) {
    throw new Error(`Embedding endpoint returned ${vector.length} dimensions; requested ${requested}`);
  }
}
