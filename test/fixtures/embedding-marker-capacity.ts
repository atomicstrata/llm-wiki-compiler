/** Build retry markers at the real count or byte boundary, without changing limits. */
import { MAX_PENDING_EMBEDDING_IDS, MAX_PENDING_EMBEDDINGS_BYTES } from "../../src/utils/constants.js";
import type { PendingEmbedding } from "../../src/utils/pending-embeddings.js";

/** Fill one marker exactly enough that another short page id cannot fit. */
export function fullEmbeddingMarker(limit: "count" | "bytes", attempts: number): PendingEmbedding[] {
  if (limit === "count") {
    return Array.from({ length: MAX_PENDING_EMBEDDING_IDS }, (_, i) => ({ pageId: `concepts/q${i}`, attempts }));
  }
  const entries: PendingEmbedding[] = [];
  let size = 2;
  for (let i = 0; ; i++) {
    const entry = { pageId: `concepts/${"q".repeat(160)}${i}`, attempts };
    const extra = Buffer.byteLength(JSON.stringify(entry)) + (entries.length ? 1 : 0);
    if (size + extra > MAX_PENDING_EMBEDDINGS_BYTES) break;
    entries.push(entry);
    size += extra;
  }
  entries[entries.length - 1].pageId += "q".repeat(MAX_PENDING_EMBEDDINGS_BYTES - size);
  return entries;
}
