/**
 * Small logical stores for binary persistence tests. Values and identities are
 * independent of the codec so serialization mistakes cannot define expectations.
 */
import type { EmbeddingStoreV3 } from "../../src/utils/embeddings-store.js";

/** Return fresh arrays so corruption tests cannot contaminate another witness. */
export function binaryFixture(): EmbeddingStoreV3 {
  return {
    version: 3, model: "model", fingerprint: "f".repeat(64), dimensions: 2,
    entries: [
      { pageId: "concepts/alpha", title: "Alpha", summary: "A", embeddingTextHash: "a".repeat(64), vector: [0.1, -0.25], updatedAt: "2026-09-10" },
      { pageId: "concepts/beta", title: "Beta", summary: "B", embeddingTextHash: "b".repeat(64), vector: [0.5, 0.75], updatedAt: "2026-09-10" },
    ],
    chunks: [{ pageId: "concepts/alpha", title: "Alpha", chunkIndex: 0, contentHash: "c".repeat(64), text: "研究\n\"evidence\"", vector: [1, -1], updatedAt: "2026-09-10" }],
  };
}
