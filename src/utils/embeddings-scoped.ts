/**
 * Plan an affected-only embedding update without running whole-store migration.
 * Unrelated records, including stale or deleted-page caches, remain untouched.
 * Incompatible, legacy, or unreadable stores require normal reconciliation;
 * attempting a partial migration could mix backend identities or discard data.
 *
 * The planner has ONE BODY, {@link planScopedEmbeddingUpdateFrom}, over the
 * bindings it reads through ({@link ScopedEmbeddingSources}): the stored
 * embeddings, the effective profile, and the live pages. Each is an existing
 * bound contract; the root form hands it the local disk's. The store
 * compatibility checks still consult the AMBIENT embedding configuration (the
 * active provider, model and endpoint from the environment), as before, so the
 * planner is storage-bound but not configuration-independent.
 */

import { diskEffectiveProfileSources, loadProfileFrom, type EffectiveProfileSources } from "../profile/load.js";
import { diskLocalEntityScans } from "../storage/disk-local-reads.js";
import {
  collectEligibleLivePagesFrom,
  contentHashesOf,
  requestedPagesExistenceFrom,
  type CollectedPage,
  type EmbeddingCollectSources,
} from "./embeddings-collect.js";
import { diskEmbeddingPageReads } from "./embeddings-pages.js";
import { diskStoredEmbeddingReads, readStoredEmbeddingsFrom, type StoredEmbeddingReads } from "./embeddings-storage.js";
import { resolveEmbeddingModel, storeMatchesActiveEmbedding, STORE_VERSION, type EmbeddingStoreV3 } from "./embeddings-store.js";
import { assertEmbeddingStoreValid } from "./embeddings-validate.js";
import type { PageId } from "./page-id.js";

/** Why an affected-only update cannot safely interpret the existing store. */
type FullEmbeddingReconciliationReason = "unreadable" | "legacy" | "backend" | "invalid";

/** Typed refusal that preserves retry budgets until full reconciliation runs. */
export class FullEmbeddingReconciliationRequiredError extends Error {
  constructor(readonly reason: FullEmbeddingReconciliationReason, detail?: string) {
    const suffix = detail === undefined ? "" : ` (${detail})`;
    super(`Embedding store requires full reconciliation: ${reason}${suffix}. Run compile to reconcile the full embedding store.`);
    this.name = "FullEmbeddingReconciliationRequiredError";
  }
}

/**
 * Retry write-ahead hook: given the pages about to be embedded and each one's
 * live content hash, durably charge their budgets and return those admitted.
 */
export type EmbeddingPrepare = (pageIds: PageId[], contentHashes: ReadonlyMap<PageId, string>) => Promise<PageId[]>;

/** An update whose writes and provider requests are confined to the supplied IDs. */
export interface ScopedEmbeddingUpdate {
  store: EmbeddingStoreV3;
  collected: CollectedPage[];
  eligible: PageId[];
  reembed: Set<PageId>;
  pruned: boolean;
  prunedIds: PageId[];
}

/**
 * What the affected-only planner reads, each through its existing bound
 * contract: the stored-embedding reader, the effective-profile loader, and the
 * live-page collector (whose page reads also answer existence).
 */
export interface ScopedEmbeddingSources {
  readonly store: StoredEmbeddingReads;
  readonly profile: EffectiveProfileSources;
  readonly live: EmbeddingCollectSources;
}

/** LOCAL DISK. The incumbent reads for `root`. Building them does no I/O. Exported only so the embedding writer's root form can compose it; in no package index. */
export function diskScopedEmbeddingSources(root: string): ScopedEmbeddingSources {
  return {
    store: diskStoredEmbeddingReads(root),
    profile: diskEffectiveProfileSources(root),
    live: { pages: diskEmbeddingPageReads(root), entities: diskLocalEntityScans(root) },
  };
}

/** Collect only affected provider inputs and preserve every unrelated store record. */
export async function planScopedEmbeddingUpdate(
  root: string,
  affectedIds: PageId[],
  prepare?: EmbeddingPrepare,
): Promise<ScopedEmbeddingUpdate> {
  // `async` so that a throw while the disk sources are built REJECTS.
  return planScopedEmbeddingUpdateFrom(diskScopedEmbeddingSources(root), affectedIds, prepare);
}

/**
 * {@link planScopedEmbeddingUpdate} over `sources`: THE ONE BODY. The store is
 * read and checked first (refusing unreadable, legacy, other-backend and invalid
 * stores), then the profile is loaded, the affected live pages are collected,
 * `prepare` admits them, affected records that are no longer eligible are
 * dropped (unrelated ones kept verbatim), and only a provably absent page that
 * left no record is reported as pruned.
 */
export async function planScopedEmbeddingUpdateFrom(
  sources: ScopedEmbeddingSources,
  affectedIds: PageId[],
  prepare?: EmbeddingPrepare,
): Promise<ScopedEmbeddingUpdate> {
  const affected = new Set(affectedIds);
  const store = await readScopedStore(sources.store);
  const profile = await loadProfileFrom(sources.profile);
  const collected = (await collectEligibleLivePagesFrom(sources.live, profile)).filter(page => affected.has(page.pageId));
  const eligible = collected.map(page => page.pageId);
  const reembed = new Set(prepare ? await prepare(eligible, contentHashesOf(collected)) : eligible);
  const eligibleSet = new Set(eligible);
  const keep = (entry: { pageId: PageId }): boolean => !affected.has(entry.pageId) || eligibleSet.has(entry.pageId);
  const entries = store.entries.filter(keep);
  const chunks = store.chunks?.filter(keep);
  const pruned = entries.length !== store.entries.length || chunks?.length !== store.chunks?.length;
  const existence = await requestedPagesExistenceFrom(sources.live.pages, profile, affectedIds);
  const kept = new Set([...entries, ...(chunks ?? [])].map(entry => entry.pageId));
  const prunedIds = affectedIds.filter(id => existence.get(id) === "absent" && !kept.has(id));
  return { store: { ...store, entries, chunks }, collected, eligible, reembed, pruned, prunedIds };
}

/** Refuse global migrations and rebuilds instead of mutating unrelated embeddings. */
async function readScopedStore(reads: StoredEmbeddingReads): Promise<EmbeddingStoreV3> {
  const result = await readStoredEmbeddingsFrom(reads);
  if (result.kind === "absent") {
    return { version: STORE_VERSION, model: resolveEmbeddingModel(), dimensions: 0, entries: [], chunks: [] };
  }
  if (result.kind === "unavailable") throw new FullEmbeddingReconciliationRequiredError("unreadable", result.reason);
  if (result.parsed.version !== STORE_VERSION) throw new FullEmbeddingReconciliationRequiredError("legacy");
  if (!storeMatchesActiveEmbedding(result.parsed.store)) throw new FullEmbeddingReconciliationRequiredError("backend");
  assertScopedStoreValid(result.parsed.store);
  return result.parsed.store as unknown as EmbeddingStoreV3;
}

/** Translate structural validation failures into the scoped planner contract. */
function assertScopedStoreValid(store: Record<string, unknown>): void {
  try {
    assertEmbeddingStoreValid(store);
  } catch {
    throw new FullEmbeddingReconciliationRequiredError("invalid");
  }
}
