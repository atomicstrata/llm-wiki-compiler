/**
 * Plan an affected-only embedding update without running whole-store migration.
 * Unrelated records, including stale or deleted-page caches, remain untouched.
 * Incompatible, legacy, or unreadable stores require normal reconciliation;
 * attempting a partial migration could mix backend identities or discard data.
 */

import { loadProfile } from "../profile/load.js";
import { collectEligibleLivePages, requestedPagesExistence, type CollectedPage } from "./embeddings-collect.js";
import { readStoredEmbeddings } from "./embeddings-storage.js";
import { resolveEmbeddingModel, storeMatchesActiveEmbedding, STORE_VERSION, type EmbeddingStoreV3 } from "./embeddings-store.js";
import { assertEmbeddingStoreValid } from "./embeddings-validate.js";
import type { PageId } from "./page-id.js";

/** An update whose writes and provider requests are confined to the supplied IDs. */
export interface ScopedEmbeddingUpdate {
  store: EmbeddingStoreV3;
  collected: CollectedPage[];
  eligible: PageId[];
  reembed: Set<PageId>;
  pruned: boolean;
  prunedIds: PageId[];
}

/** Collect only affected provider inputs and preserve every unrelated store record. */
export async function planScopedEmbeddingUpdate(
  root: string,
  affectedIds: PageId[],
  prepare?: (ids: PageId[]) => Promise<PageId[]>,
): Promise<ScopedEmbeddingUpdate> {
  const affected = new Set(affectedIds);
  const store = await readScopedStore(root);
  const profile = await loadProfile(root);
  const collected = (await collectEligibleLivePages(root, profile)).filter(page => affected.has(page.pageId));
  const eligible = collected.map(page => page.pageId);
  const reembed = new Set(prepare ? await prepare(eligible) : eligible);
  const eligibleSet = new Set(eligible);
  const keep = (entry: { pageId: PageId }): boolean => !affected.has(entry.pageId) || eligibleSet.has(entry.pageId);
  const entries = store.entries.filter(keep);
  const chunks = store.chunks?.filter(keep);
  const pruned = entries.length !== store.entries.length || chunks?.length !== store.chunks?.length;
  const existence = await requestedPagesExistence(root, profile, affectedIds);
  const kept = new Set([...entries, ...(chunks ?? [])].map(entry => entry.pageId));
  const prunedIds = affectedIds.filter(id => existence.get(id) === "absent" && !kept.has(id));
  return { store: { ...store, entries, chunks }, collected, eligible, reembed, pruned, prunedIds };
}

/** Refuse global migrations and rebuilds instead of mutating unrelated embeddings. */
async function readScopedStore(root: string): Promise<EmbeddingStoreV3> {
  const result = await readStoredEmbeddings(root);
  if (result.kind === "absent") {
    return { version: STORE_VERSION, model: resolveEmbeddingModel(), dimensions: 0, entries: [], chunks: [] };
  }
  if (result.kind !== "parsed" || result.parsed.version !== STORE_VERSION || !storeMatchesActiveEmbedding(result.parsed.store)) {
    throw new Error("Embedding store requires full reconciliation; run compile before retrying scoped embeddings.");
  }
  assertEmbeddingStoreValid(result.parsed.store);
  return result.parsed.store as unknown as EmbeddingStoreV3;
}
