/**
 * Embedding-based semantic search utilities — v3 writer orchestration.
 *
 * Maintains a persistent store of page and chunk embeddings in
 * .llmwiki/embeddings.json. The store is keyed by qualified `pageId`
 * (`<namespace>/<page-part>`) as of v3, so a concept `foo` and a query `foo`
 * (or a typed `papers/foo`) are independent records.
 *
 * The writer is version-driven and unconditionally migrates: whenever the
 * on-disk store is below v3, {@link migrateEmbeddingStore} re-keys the
 * content-verified vectors to v3 BEFORE the no-op early-return, so even an empty
 * change set on a v2 store still persists a v3 store. Eligible pages the
 * migration could not preserve, plus the explicit change set, are re-embedded
 * keyed by pageId.
 *
 * Reentrancy (S11/S3): {@link updateEmbeddingsLockedCore} assumes the caller
 * already holds the project lock (compile / review / import). {@link updateEmbeddings}
 * is the self-locking wrapper for callers with no lock (query --save).
 */

import * as output from "./output.js";
import {
  STORE_VERSION,
  writeEmbeddingStore,
  readStoreForUpdate,
  resolveEmbeddingModel,
  type EmbeddingStoreV3,
} from "./embeddings-store.js";
import { resolveEmbedBatchSize } from "./embeddings-batch.js";
import { getActiveProviderName } from "./provider.js";
import { acquireLockBlocking, releaseLock } from "./lock.js";
import { loadProfile } from "../profile/load.js";
import { migrateEmbeddingStore } from "./embeddings-migrate.js";
import { collectEligibleLivePages, type CollectedPage } from "./embeddings-collect.js";
import { reembedIntoStore, type ReembedReport } from "./embeddings-write.js";
import type { PageId } from "./page-id.js";

/**
 * Re-embed the given changed page ids and migrate the store to v3, holding the
 * project lock for the read-modify-write. Self-locking wrapper for callers that
 * do NOT already hold the lock (e.g. `query --save`).
 *
 * @param root - Project root path.
 * @param changedPageIds - Qualified page ids whose pages changed this write.
 */
export async function updateEmbeddings(root: string, changedPageIds: PageId[]): Promise<void> {
  await acquireLockBlocking(root);
  try {
    await updateEmbeddingsLockedCore(root, changedPageIds);
  } finally {
    await releaseLock(root);
  }
}

/**
 * Re-embed + migrate ASSUMING the caller already holds the project lock
 * (compile, review-approve, OKF import). Never acquires the lock itself, so it
 * is safe to call from inside an existing lock scope without deadlocking.
 *
 * Returns the re-embedded set + the eligible universe so callers can reconcile a
 * durable retry marker per-id (the pending-embeddings lifecycle): an id present in
 * `eligible` but absent from `embedded` was SKIPPED (transiently ineligible), and
 * one absent from `eligible` is ineligible/deleted — neither was embedded, so the
 * caller must NOT clear it. ADDITIVE: callers that ignore the return still compile.
 *
 * @param root - Project root path.
 * @param changedPageIds - Qualified page ids whose pages changed this write.
 * @returns `embedded` = the re-embed INTENT set — the ids this write ATTEMPTED to
 *   re-embed (`[]` on the no-persist early return). It may OVER-include: a
 *   migration-only id that `reembedIntoStore` later skips (e.g. filtered against
 *   `collected`) still appears here, so a caller must treat it as "attempted", not
 *   ground-truth "persisted". `eligible` = the live-eligible universe the core
 *   considered. (For the pending-marker lifecycle the over-inclusion is benign — an
 *   over-cleared id that is still eligible is simply re-queued on the next compile.)
 */
export async function updateEmbeddingsLockedCore(
  root: string,
  changedPageIds: PageId[],
): Promise<{ embedded: PageId[]; eligible: PageId[] }> {
  const model = resolveEmbeddingModel();
  const profile = await loadProfile(root);
  const collected = await collectEligibleLivePages(root, profile);
  const eligible = collected.map((p) => p.pageId);
  const parsedOld = await readStoreForUpdate(root);
  const onDiskVersion = parsedOld?.version ?? 0;

  const { store: migrated, reembedPageIds } = migrateEmbeddingStore(parsedOld, collected, model);
  const reembed = unionReembed(reembedPageIds, changedPageIds, collected);

  // Persist when there is real work: something to re-embed, a sub-v3 store to
  // upgrade (version-driven migration, S1), OR a prune that shrank the store
  // (a deleted page dropped by migration). A clean project (no store on disk)
  // with nothing eligible stays clean — never materialize an empty store.
  if (!shouldPersist(parsedOld, migrated, reembed, onDiskVersion)) return { embedded: [], eligible };

  await embedAndPersist(root, migrated, collected, reembed, onDiskVersion);
  // The re-embed INTENT set (what we attempted). It may over-include an id the
  // writer skips — see the @returns note; the marker lifecycle tolerates that.
  return { embedded: [...reembed], eligible };
}

/**
 * Decide whether the read-modify-write must persist. True when: there is
 * something to re-embed; the on-disk store is a sub-v3 version to upgrade; OR the
 * migration pruned records (a deleted page) so the migrated store is smaller than
 * what was on disk. An absent on-disk store with nothing to embed stays clean.
 */
function shouldPersist(
  parsedOld: Awaited<ReturnType<typeof readStoreForUpdate>>,
  migrated: EmbeddingStoreV3,
  reembed: Set<PageId>,
  onDiskVersion: number,
): boolean {
  if (reembed.size > 0) return true;
  if (onDiskVersion > 0 && onDiskVersion < STORE_VERSION) return true;
  if (onDiskVersion === 0) return false;
  return migratedShrankStore(parsedOld, migrated);
}

/** True when migration produced fewer entries/chunks than the on-disk store had. */
function migratedShrankStore(
  parsedOld: Awaited<ReturnType<typeof readStoreForUpdate>>,
  migrated: EmbeddingStoreV3,
): boolean {
  const oldEntries = countField(parsedOld, "entries");
  const oldChunks = countField(parsedOld, "chunks");
  return migrated.entries.length < oldEntries || (migrated.chunks?.length ?? 0) < oldChunks;
}

/** Count an array field on a parsed store (0 when absent / not an array). */
function countField(parsedOld: Awaited<ReturnType<typeof readStoreForUpdate>>, field: "entries" | "chunks"): number {
  const value = parsedOld?.store[field];
  return Array.isArray(value) ? value.length : 0;
}

/** Union the migration's re-embed set with the change set, scoped to eligible pages. */
function unionReembed(
  reembedPageIds: PageId[],
  changedPageIds: PageId[],
  collected: CollectedPage[],
): Set<PageId> {
  const eligible = new Set(collected.map((p) => p.pageId));
  const union = new Set<PageId>(reembedPageIds);
  for (const id of changedPageIds) {
    if (eligible.has(id)) union.add(id);
  }
  return union;
}

/** Embed the re-embed set, merge over the migrated store, and persist v3. */
async function embedAndPersist(
  root: string,
  migrated: EmbeddingStoreV3,
  collected: CollectedPage[],
  reembed: Set<PageId>,
  onDiskVersion: number,
): Promise<void> {
  const batchSize = resolveEmbedBatchSize(getActiveProviderName());
  const expectedDim = migrated.dimensions > 0 ? migrated.dimensions : undefined;
  const { store, report } = await reembedIntoStore(migrated, collected, reembed, batchSize, expectedDim);
  await writeEmbeddingStore(root, store);
  reportPersist(store, report, onDiskVersion);
}

/** Emit the embeddings report; on a migration, name the upgrade explicitly (M4). */
function reportPersist(store: EmbeddingStoreV3, report: ReembedReport, onDiskVersion: number): void {
  if (onDiskVersion > 0 && onDiskVersion < STORE_VERSION) {
    output.status(
      "*",
      output.dim(`upgrading embedding index: re-embedding ${report.pagesEmbedded} of ${store.entries.length} records`),
    );
    return;
  }
  output.status(
    "*",
    output.dim(
      `Embeddings: ${report.pagesEmbedded} page(s), ${report.chunksEmbedded} chunk(s) embedded ` +
      `(${report.requests} batched requests).`,
    ),
  );
}

// Public surface preserved across the module split. Consumers import these from
// "./embeddings.js" today; keep that contract.
export {
  readEmbeddingStore,
  writeEmbeddingStore,
  resolveEmbeddingModel,
  type EmbeddingEntry,
  type ChunkEmbeddingEntry,
  type EmbeddingStore,
} from "./embeddings-store.js";
export {
  cosineSimilarity,
  findTopK,
  findTopKChunks,
  findRelevantPages,
  findRelevantChunks,
  resetStaleEmbeddingWarnings,
} from "./embeddings-search.js";
