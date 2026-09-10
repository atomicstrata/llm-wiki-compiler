/**
 * Persistence errors shared by the logical store facade and format-specific
 * storage. Kept separate so transport selection does not create an error cycle.
 */

/** A derived embedding index exceeds the capacity of its storage format. */
export class EmbeddingStoreFullError extends Error {
  constructor(message = "embedding store is full; prune entries or use a lower-dimension model") {
    super(message);
    this.name = "EmbeddingStoreFullError";
  }
}
