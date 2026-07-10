/**
 * @file test/fixtures/v3-store.ts
 * @description Shared helpers for tests asserting on the v3 embedding store the
 * live writer now persists: read the on-disk store as a v3 store, and build a
 * qualified concept-namespace pageId from a bare slug.
 */

import { readStoreForUpdate, type EmbeddingStoreV3 } from "../../src/utils/embeddings-store.js";
import { qualifiedPageId } from "../../src/utils/page-id.js";

/** Read the on-disk store as a v3 store (the live writer persists v3), or null. */
export async function readV3Store(root: string): Promise<EmbeddingStoreV3 | null> {
  const parsed = await readStoreForUpdate(root);
  return parsed?.version === 3 ? (parsed.store as unknown as EmbeddingStoreV3) : null;
}

/** The qualified concept-namespace pageId for a bare slug. */
export function conceptId(slug: string): string {
  return qualifiedPageId("concepts", slug);
}
