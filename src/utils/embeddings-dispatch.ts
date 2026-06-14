/**
 * Thin dispatch wrapper that selects between the default and batched embedding
 * update pipelines based on LLMWIKI_BATCH_EMBEDDINGS.
 *
 * This file exists to break a circular import: embeddings.ts ↔ embeddings-batch.ts.
 * Callers import from here instead of embedding the dispatch inside embeddings.ts.
 */

import { updateEmbeddings } from "./embeddings.js";

export async function updateEmbeddingsDispatched(root: string, changedSlugs: string[]): Promise<void> {
  if (process.env.LLMWIKI_BATCH_EMBEDDINGS === "true") {
    const { updateEmbeddingsBatched } = await import("./embeddings-batch.js");
    return updateEmbeddingsBatched(root, changedSlugs);
  }
  return updateEmbeddings(root, changedSlugs);
}
