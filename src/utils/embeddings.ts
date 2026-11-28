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
 * is the self-locking wrapper for callers with no lock (query --save); the lock
 * it takes stays a named LOCAL DISK mechanism.
 *
 * STORAGE. The locked core has ONE BODY, {@link updateEmbeddingsLockedCoreFrom},
 * over the raw storage it reads and writes ({@link EmbeddingWriterSources}): the
 * stored-embedding reads, the effective profile, the live pages and the store's
 * raw writes. `updateEmbeddingsLockedCore` hands it the local disk's. NOT bound
 * here, and still AMBIENT: the provider that embeds (and its batch size), the
 * active embedding configuration (model, fingerprint, the disable switch, the
 * binary opt-in) and the process output. `prepare` and `recorder` stay the
 * caller's own inputs.
 */

import { indexedActive } from "../indexed/routing.js";
import { refreshShardedEmbeddings } from "../vectors/writer.js";
import * as output from "./output.js";
import {
  STORE_VERSION,
  writeEmbeddingStoreFrom,
  readStoreForUpdateFrom,
  resolveEmbeddingModel,
  resolveEmbeddingFingerprint,
  storeMatchesActiveEmbedding,
  type EmbeddingStoreV3,
} from "./embeddings-store.js";
import { diskStoredEmbeddingWrites, type StoredEmbeddingWrites } from "./embeddings-storage.js";
import { resolveEmbedBatchSize } from "./embeddings-batch.js";
import { getActiveEmbeddingProviderName } from "./embedding-provider.js";
import { releaseLock } from "./lock.js";
import { acquireMutationLockBlocking } from "../operation-bundles/lock-gate.js";
import { loadProfileFrom } from "../profile/load.js";
import { migrateEmbeddingStore } from "./embeddings-migrate.js";
import { collectEligibleLivePagesFrom, contentHashesOf, requestedPagesExistenceFrom, type PageExistence, type CollectedPage } from "./embeddings-collect.js";
import { reembedIntoStore, type ReembedReport } from "./embeddings-write.js";
import type { PageId } from "./page-id.js";
import { ENV_EMBEDDINGS } from "./constants.js";
import { embeddingsDisabled } from "./embeddings-config.js";
import { retainDeferredEmbeddings } from "./embeddings-deferred.js";
import { diskScopedEmbeddingSources, planScopedEmbeddingUpdateFrom, type EmbeddingPrepare, type ScopedEmbeddingSources } from "./embeddings-scoped.js";
import type { EmbeddingAttemptRecorder } from "./embedding-attempts.js";

/** Full reconciliation is the legacy default; batches can opt into affected-only writes. */
export type EmbeddingRefreshScope = "drain" | "affected-only";

/** What one locked refresh reports: the attempted set, the eligible universe, and the settled absent pages. */
type EmbeddingRefreshResult = { embedded: PageId[]; eligible: PageId[]; pruned: PageId[] };

/**
 * The raw storage the locked core runs over: the affected-only planner's own
 * sources ({@link ScopedEmbeddingSources}: the stored-embedding reads, the
 * effective profile and the live pages), plus the store's RAW writes. Every
 * member is an existing bound contract; none migrates, plans, validates or
 * persists on the core's behalf.
 */
export interface EmbeddingWriterSources extends ScopedEmbeddingSources {
  readonly writes: StoredEmbeddingWrites;
  /**
   * OPTIONAL: the piecewise vector writer when the project is `local-indexed`
   * (the core then dispatches to it), or `null` when the incumbent whole
   * store is the authority. Absent in test doubles.
   */
  sharded?(): Promise<ShardedEmbeddingWriter | null>;
}

/** What the core asks of the piecewise writer. */
export interface ShardedEmbeddingWriter {
  refresh(changedPageIds: PageId[], prepare: EmbeddingPrepare | undefined, affectedOnly: boolean, recorder?: EmbeddingAttemptRecorder): Promise<EmbeddingRefreshResult>;
}

/** LOCAL DISK. The incumbent reads and writes for `root`. Building them does no I/O. Exported only so the refresh's root forms can compose it; in no package index. */
export function diskEmbeddingWriterSources(root: string): EmbeddingWriterSources {
  const scoped = diskScopedEmbeddingSources(root);
  return {
    ...scoped, writes: diskStoredEmbeddingWrites(root),
    sharded: async () => ((await indexedActive(root))
      ? { refresh: (changed, prepare, affectedOnly, recorder) => refreshShardedEmbeddings(root, scoped, changed, prepare, affectedOnly, recorder) }
      : null),
  };
}

/**
 * Re-embed the given changed page ids and migrate the store to v3, holding the
 * project lock for the read-modify-write. Self-locking wrapper for callers that
 * do NOT already hold the lock (e.g. `query --save`).
 *
 * @param root - Project root path.
 * @param changedPageIds - Qualified page ids whose pages changed this write.
 */
export async function updateEmbeddings(root: string, changedPageIds: PageId[]): Promise<void> {
  if (embeddingsDisabled()) {
    output.verbose(`embeddings: skipped because ${ENV_EMBEDDINGS} disables refreshes`);
    return;
  }
  await acquireMutationLockBlocking(root, "ordinary");
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
 * @param prepare - Optional write-ahead callback that filters the discovered intent set. It also
 *   receives each page's live content hash, so retry budgets bind to the content being sent.
 * @param scope - The default drain reconciles globally; affected-only preserves unrelated records and refuses migrations.
 * @param recorder - Optional attempt accounting: which pages reached the provider, and whether the store persisted.
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
  prepare?: EmbeddingPrepare,
  scope: EmbeddingRefreshScope = "drain",
  recorder?: EmbeddingAttemptRecorder,
): Promise<EmbeddingRefreshResult> {
  // `async` so that a throw while the disk sources are built REJECTS.
  return updateEmbeddingsLockedCoreFrom(diskEmbeddingWriterSources(root), changedPageIds, prepare, scope, recorder);
}

/**
 * {@link updateEmbeddingsLockedCore} over {@link EmbeddingWriterSources}: THE
 * ONE BODY. The disable switch, the scope, the migration, the retry hand-off
 * (`prepare` before any provider call), deferred retention, the prune and
 * persist conditions, the fingerprint stamp and `markPersisted` after a
 * successful write are all decided here, in the incumbent order.
 *
 * @param sources - The stored-embedding reads, the effective profile, the live pages and the store's raw writes.
 * @param changedPageIds - Qualified page ids whose pages changed this write.
 * @param prepare - The caller's optional write-ahead hook, as for the root form.
 * @param scope - `drain` (the default) or `affected-only`.
 * @param recorder - The caller's optional attempt accounting.
 */
export async function updateEmbeddingsLockedCoreFrom(
  sources: EmbeddingWriterSources,
  changedPageIds: PageId[],
  prepare?: EmbeddingPrepare,
  scope: EmbeddingRefreshScope = "drain",
  recorder?: EmbeddingAttemptRecorder,
): Promise<EmbeddingRefreshResult> {
  if (embeddingsDisabled()) {
    output.verbose(`embeddings: skipped because ${ENV_EMBEDDINGS} disables refreshes`);
    return { embedded: [], eligible: [], pruned: [] };
  }
  const sharded = await sources.sharded?.();
  if (sharded) return sharded.refresh(changedPageIds, prepare, scope === "affected-only", recorder); // local-indexed: touched pieces only
  if (scope === "affected-only") return updateAffectedEmbeddings(sources, changedPageIds, prepare, recorder);
  const model = resolveEmbeddingModel();
  const profile = await loadProfileFrom(sources.profile);
  const collected = await collectEligibleLivePagesFrom(sources.live, profile);
  const eligible = collected.map((p) => p.pageId);
  const parsedOld = await readStoreForUpdateFrom(sources.store);
  const onDiskVersion = parsedOld?.version ?? 0;

  // A store whose vectors came from a DIFFERENT embedding configuration — other
  // provider, other endpoint, other model — cannot have any of them preserved,
  // so hand the migration `null` and let its existing rebuild path own the case.
  // Gating here rather than inside the migration keeps that function pure: it
  // takes the active identity as data and never reads the environment.
  const preservable = storeMatchesActiveEmbedding(parsedOld?.store) ? parsedOld : null;
  const { store: migrated, reembedPageIds } = migrateEmbeddingStore(preservable, collected, model);
  const discovered = unionReembed(reembedPageIds, changedPageIds, collected);
  // The draining caller records discovered work BEFORE any provider call and
  // removes quarantined ids. Direct callers retain the existing refresh contract.
  const reembed = prepare ? new Set(await prepare([...discovered], contentHashesOf(collected))) : discovered;
  retainDeferredEmbeddings(preservable, migrated, new Set([...discovered].filter(id => !reembed.has(id))));
  const pruned = absentRequestedPageIds(changedPageIds, await requestedPagesExistenceFrom(sources.live.pages, profile, changedPageIds), migrated);

  // Persist when there is real work: something to re-embed, a sub-v3 store to
  // upgrade (version-driven migration, S1), OR a prune that shrank the store
  // (a deleted page dropped by migration). A clean project (no store on disk)
  // with nothing eligible stays clean — never materialize an empty store.
  if (!shouldPersist(parsedOld, migrated, reembed, onDiskVersion)) return { embedded: [], eligible, pruned };

  await embedAndPersist(sources.writes, migrated, collected, reembed, onDiskVersion, recorder);
  // The re-embed INTENT set (what we attempted). It may over-include an id the
  // writer skips — see the @returns note; the marker lifecycle tolerates that.
  return { embedded: [...reembed], eligible, pruned };
}

/** Settle only provably absent requested pages no longer retained in the migrated store. */
function absentRequestedPageIds(requested: PageId[], existence: Map<PageId, PageExistence>, migrated: EmbeddingStoreV3): PageId[] {
  const kept = new Set<PageId>([...migrated.entries.map(e => e.pageId), ...(migrated.chunks ?? []).map(c => c.pageId)]);
  return requested.filter(pageId => existence.get(pageId) === "absent" && !kept.has(pageId));
}

/** Apply the bound scoped plan through the existing provider and the bound validated write. */
async function updateAffectedEmbeddings(
  sources: EmbeddingWriterSources,
  affectedIds: PageId[],
  prepare?: EmbeddingPrepare,
  recorder?: EmbeddingAttemptRecorder,
): Promise<EmbeddingRefreshResult> {
  if (affectedIds.length === 0) return { embedded: [], eligible: [], pruned: [] };
  const update = await planScopedEmbeddingUpdateFrom(sources, affectedIds, prepare);
  if (update.reembed.size > 0) {
    await embedAndPersist(sources.writes, update.store, update.collected, update.reembed, STORE_VERSION, recorder);
  } else if (update.pruned) await writeEmbeddingStoreFrom(sources.writes, update.store);
  return { embedded: [...update.reembed], eligible: update.eligible, pruned: update.prunedIds };
}

/**
 * Decide whether the read-modify-write must persist. True when: there is
 * something to re-embed; the on-disk store is a sub-v3 version to upgrade; OR the
 * migration pruned records (a deleted page) so the migrated store is smaller than
 * what was on disk. An absent on-disk store with nothing to embed stays clean.
 */
function shouldPersist(
  parsedOld: Awaited<ReturnType<typeof readStoreForUpdateFrom>>,
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
  parsedOld: Awaited<ReturnType<typeof readStoreForUpdateFrom>>,
  migrated: EmbeddingStoreV3,
): boolean {
  const oldEntries = countField(parsedOld, "entries");
  const oldChunks = countField(parsedOld, "chunks");
  return migrated.entries.length < oldEntries || (migrated.chunks?.length ?? 0) < oldChunks;
}

/** Count an array field on a parsed store (0 when absent / not an array). */
function countField(parsedOld: Awaited<ReturnType<typeof readStoreForUpdateFrom>>, field: "entries" | "chunks"): number {
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

/** Embed the re-embed set, merge over the migrated store, and persist v3 through the bound validated write. */
async function embedAndPersist(
  writes: StoredEmbeddingWrites,
  migrated: EmbeddingStoreV3,
  collected: CollectedPage[],
  reembed: Set<PageId>,
  onDiskVersion: number,
  recorder?: EmbeddingAttemptRecorder,
): Promise<void> {
  const batchSize = resolveEmbedBatchSize(getActiveEmbeddingProviderName());
  const expectedDim = migrated.dimensions > 0 ? migrated.dimensions : undefined;
  const { store, report } = await reembedIntoStore(migrated, collected, reembed, batchSize, expectedDim, recorder);
  // Stamp the identity of the configuration that actually produced these vectors.
  // Done here, at the single write boundary, so no path can persist a store whose
  // provenance is unrecorded — that is what the next read gates preservation on.
  const stamped: EmbeddingStoreV3 = { ...store, fingerprint: resolveEmbeddingFingerprint() };
  await writeEmbeddingStoreFrom(writes, stamped);
  recorder?.markPersisted();
  reportPersist(stamped, report, onDiskVersion);
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
