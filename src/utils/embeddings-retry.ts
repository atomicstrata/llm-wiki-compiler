/**
 * Durable retry bookkeeping for shared embedding refreshes. Automatically
 * discovered work uses the same attempt budget as explicit page changes.
 * Quarantined ids live separately from the active pending queue so an empty
 * queue cannot make reconciliation forget which pages exhausted their budget.
 * The caller must hold the project lock throughout this lifecycle.
 */

import { MAX_PENDING_EMBEDDING_ATTEMPTS, QUARANTINED_EMBEDDINGS_FILE } from "./constants.js";
import type { PageId } from "./page-id.js";
import {
  loadPendingEmbeddings,
  readPendingMarker,
  writePendingEmbeddings,
  mergeFreshAttempts,
  normalizeMarker,
  settleAfterSuccess,
  settleAfterFailure,
  warnQuarantined,
  type PendingEmbedding,
  type SettleResult,
} from "./pending-embeddings.js";

/** Exhausted entries may remain pending when the quarantine marker is full. */
function exhausted(entry: PendingEmbedding): boolean {
  return entry.attempts >= MAX_PENDING_EMBEDDING_ATTEMPTS;
}

/** Retry state shared between planning, provider execution, and settlement. */
class EmbeddingRetry {
  /** Eligible, non-quarantined pages whose budgets could not be recorded. */
  deferred: PageId[] = [];
  /** Keep mutable state private to a single locked refresh. */
  constructor(
    private readonly root: string,
    private pending: PendingEmbedding[],
    private quarantined: PendingEmbedding[],
    private readonly scope?: ReadonlySet<PageId>,
  ) {}

  /** Active retry ids; overflow quarantines must never reach the provider again. */
  get pageIds(): PageId[] {
    return this.active.map((entry) => entry.pageId);
  }

  /** Record explicit work before even store discovery can fail. */
  async recordPending(): Promise<void> {
    const prior = await readPendingMarker(this.root);
    if (this.pending.length > 0 || prior.status === "ok") {
      await writePendingEmbeddings(this.root, this.pending);
    }
    // The writer applies both resource caps. Never attempt work it dropped.
    this.pending = await loadPendingEmbeddings(this.root);
    if (this.scope) {
      const recorded = new Set(this.pageIds);
      this.deferred = [...this.scope].filter(id => !recorded.has(id));
    }
  }

  /** Add discovered work to the budget while excluding durable quarantines. */
  async prepare(discovered: PageId[]): Promise<PageId[]> {
    const blocked = new Set([...this.quarantined, ...this.pending.filter(exhausted)].map((entry) => entry.pageId));
    const allowed = discovered.filter((id) => !blocked.has(id) && this.includes(id));
    // Already recorded budgets take precedence over newly discovered work.
    this.pending = mergeFreshAttempts(this.pending, [...this.pending.map(e => e.pageId), ...allowed]);
    await this.recordPending();
    const recorded = new Set(this.pageIds);
    const unrecorded = allowed.filter(id => !recorded.has(id));
    this.deferred = this.scope ? [...new Set([...this.deferred, ...unrecorded])] : unrecorded;
    return allowed.filter(id => recorded.has(id));
  }

  /** Clear completed work and age temporarily ineligible entries. */
  async succeed(embedded: PageId[], eligible: PageId[]): Promise<void> {
    await this.settle(settleAfterSuccess(this.active, embedded, eligible));
  }

  /** Count failures for explicit and automatically discovered work alike. */
  async fail(): Promise<void> {
    await this.settle(settleAfterFailure(this.active, this.pageIds));
  }

  /** Restrict batch reconciliation without changing the compiler's full-drain default. */
  private includes(id: PageId): boolean {
    return this.scope === undefined || this.scope.has(id);
  }

  /** Only attempted IDs may consume budgets or be settled by this refresh. */
  private get active(): PendingEmbedding[] {
    return this.pending.filter(entry => this.includes(entry.pageId) && !exhausted(entry));
  }

  /** Persist exclusions before removing active entries, then report new quarantines. */
  private async settle(result: SettleResult): Promise<void> {
    const untouched = this.pending.filter(entry => !this.includes(entry.pageId));
    const retiring = [...this.pending.filter(entry => this.includes(entry.pageId) && exhausted(entry)), ...result.quarantined];
    if (retiring.length > 0) {
      this.quarantined.push(...retiring);
      await writePendingEmbeddings(this.root, this.quarantined, QUARANTINED_EMBEDDINGS_FILE);
      this.quarantined = await loadPendingEmbeddings(this.root, QUARANTINED_EMBEDDINGS_FILE);
    }
    const durable = new Set(this.quarantined.map(e => e.pageId));
    const held = retiring.filter(e => !durable.has(e.pageId));
    // Retain overflow with its exhausted count; never retire an unpersisted exclusion.
    if (this.pending.length > 0) await writePendingEmbeddings(this.root, [...untouched, ...held, ...result.survivors]);
    warnQuarantined(result.quarantined);
  }
}

/** Load an affected-only retry set, retaining unrelated budgets and exclusions verbatim. */
export async function loadScopedEmbeddingRetry(root: string, affectedIds: PageId[]): Promise<EmbeddingRetry> {
  const { pending, quarantined } = await readScopedRetryState(root);
  const scope = new Set(affectedIds);
  const released = quarantined.filter(entry => !scope.has(entry.pageId));
  if (released.length !== quarantined.length) await writePendingEmbeddings(root, released, QUARANTINED_EMBEDDINGS_FILE);
  return new EmbeddingRetry(root, scopedPendingEntries(pending, quarantined, affectedIds), released, scope);
}

/**
 * Affected IDs a scoped refresh could not record in the retry marker, computed
 * with the refresh's own merge and the marker's own caps, without writing.
 * Batch approval checks this before promoting pages, so a full marker refuses
 * the batch up front instead of failing after pages are already live.
 */
export async function unrecordableScopedIds(root: string, affectedIds: PageId[]): Promise<PageId[]> {
  const { pending, quarantined } = await readScopedRetryState(root);
  const recorded = new Set(normalizeMarker(scopedPendingEntries(pending, quarantined, affectedIds)).map(e => e.pageId));
  return [...new Set(affectedIds)].filter(id => !recorded.has(id));
}

/** Both markers, refusing to guess when either cannot be read. */
async function readScopedRetryState(root: string): Promise<{ pending: PendingEmbedding[]; quarantined: PendingEmbedding[] }> {
  const [pendingRead, quarantineRead] = await Promise.all([
    readPendingMarker(root), readPendingMarker(root, QUARANTINED_EMBEDDINGS_FILE),
  ]);
  if (pendingRead.status === "unavailable" || quarantineRead.status === "unavailable") {
    throw new Error("Embedding retry state unavailable; scoped refresh cannot preserve unrelated entries.");
  }
  return { pending: pendingRead.entries, quarantined: quarantineRead.entries };
}

/** The retry entries a scoped refresh records: unrelated budgets first, then the affected work. */
function scopedPendingEntries(pending: PendingEmbedding[], quarantined: PendingEmbedding[], affectedIds: PageId[]): PendingEmbedding[] {
  const scope = new Set(affectedIds);
  const blocked = new Set(quarantined.map(entry => entry.pageId));
  const kept = pending.filter(entry => !scope.has(entry.pageId) || (!blocked.has(entry.pageId) && !exhausted(entry)));
  // Preserve all existing entries before new work so the marker's caps cannot evict unrelated IDs.
  return mergeFreshAttempts(kept, [...kept.map(entry => entry.pageId), ...affectedIds]);
}

/**
 * Durably queue affected IDs for the next refresh without attempting them,
 * using the scoped refresh's own write-ahead step. Returns the IDs the retry
 * marker's caps could not record, so callers can refuse rather than drop work.
 * Throws unless the persisted markers show the IDs' exclusions lifted.
 */
export async function queueScopedEmbeddingRetry(root: string, affectedIds: PageId[]): Promise<PageId[]> {
  const retry = await loadScopedEmbeddingRetry(root, affectedIds);
  await retry.recordPending();
  await assertExclusionsLifted(root, affectedIds);
  return retry.deferred;
}

/**
 * Lift every exclusion on explicitly changed IDs without queueing or attempting
 * work: their quarantine entries and any exhausted pending entries (where
 * quarantine overflow is retained). With refreshes disabled this is the whole
 * handoff; a later enabled compile's content-hash discovery re-finds their
 * stale vectors once nothing excludes them. Unrelated entries are untouched.
 */
export async function releaseScopedExclusions(root: string, changedIds: PageId[]): Promise<void> {
  const { pending, quarantined } = await readScopedRetryState(root);
  const changed = new Set(changedIds);
  const keptQuarantine = quarantined.filter(entry => !changed.has(entry.pageId));
  if (keptQuarantine.length !== quarantined.length) await writePendingEmbeddings(root, keptQuarantine, QUARANTINED_EMBEDDINGS_FILE);
  const keptPending = pending.filter(entry => !(changed.has(entry.pageId) && exhausted(entry)));
  if (keptPending.length !== pending.length) await writePendingEmbeddings(root, keptPending);
  await assertExclusionsLifted(root, changedIds);
}

/**
 * The marker writers swallow write and unlink failures, so callers that retire
 * other recovery state must confirm the persisted result rather than trust them.
 */
async function assertExclusionsLifted(root: string, changedIds: PageId[]): Promise<void> {
  const { pending, quarantined } = await readScopedRetryState(root);
  const changed = new Set(changedIds);
  if ([...quarantined, ...pending.filter(exhausted)].some(entry => changed.has(entry.pageId))) {
    throw new Error("Embedding retry state could not be updated; changed pages are still excluded from refresh.");
  }
}

/** Load retry state; only an explicit page change releases a quarantined id. */
export async function loadEmbeddingRetry(root: string, changedPageIds: PageId[]): Promise<EmbeddingRetry> {
  const prior = await loadPendingEmbeddings(root, QUARANTINED_EMBEDDINGS_FILE);
  const fresh = new Set(changedPageIds);
  const quarantined = prior.filter((entry) => !fresh.has(entry.pageId));
  if (quarantined.length !== prior.length) {
    await writePendingEmbeddings(root, quarantined, QUARANTINED_EMBEDDINGS_FILE);
  }
  // A crash may leave an id in both files: quarantine wins, and an explicit
  // re-queue starts at zero rather than inheriting that abandoned pending count.
  const blocked = new Set(prior.map((entry) => entry.pageId));
  const pending = (await loadPendingEmbeddings(root))
    .filter((e) => !blocked.has(e.pageId) && !(exhausted(e) && fresh.has(e.pageId)));
  // Never evict charged budgets for new work. Fresh ids still precede unattempted backlog.
  const charged = pending.filter(e => e.attempts > 0).map(e => e.pageId);
  return new EmbeddingRetry(root, mergeFreshAttempts(pending, [...charged, ...changedPageIds]), quarantined);
}
