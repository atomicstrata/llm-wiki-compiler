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
  ) {}

  /** Active retry ids; overflow quarantines must never reach the provider again. */
  get pageIds(): PageId[] {
    return this.pending.filter(entry => !exhausted(entry)).map((entry) => entry.pageId);
  }

  /** Record explicit work before even store discovery can fail. */
  async recordPending(): Promise<void> {
    const prior = await readPendingMarker(this.root);
    if (this.pending.length > 0 || prior.status === "ok") {
      await writePendingEmbeddings(this.root, this.pending);
    }
    // The writer applies both resource caps. Never attempt work it dropped.
    this.pending = await loadPendingEmbeddings(this.root);
  }

  /** Add discovered work to the budget while excluding durable quarantines. */
  async prepare(discovered: PageId[]): Promise<PageId[]> {
    const blocked = new Set([...this.quarantined, ...this.pending.filter(exhausted)].map((entry) => entry.pageId));
    const allowed = discovered.filter((id) => !blocked.has(id));
    // Already recorded budgets take precedence over newly discovered work.
    this.pending = mergeFreshAttempts(this.pending, [...this.pending.map(e => e.pageId), ...allowed]);
    await this.recordPending();
    const recorded = new Set(this.pageIds);
    this.deferred = allowed.filter(id => !recorded.has(id));
    return allowed.filter(id => recorded.has(id));
  }

  /** Clear completed work and age temporarily ineligible entries. */
  async succeed(embedded: PageId[], eligible: PageId[]): Promise<void> {
    await this.settle(settleAfterSuccess(this.pending.filter(e => !exhausted(e)), embedded, eligible));
  }

  /** Count failures for explicit and automatically discovered work alike. */
  async fail(): Promise<void> {
    await this.settle(settleAfterFailure(this.pending.filter(e => !exhausted(e)), this.pageIds));
  }

  /** Persist exclusions before removing active entries, then report new quarantines. */
  private async settle(result: SettleResult): Promise<void> {
    const retiring = [...this.pending.filter(exhausted), ...result.quarantined];
    if (retiring.length > 0) {
      this.quarantined.push(...retiring);
      await writePendingEmbeddings(this.root, this.quarantined, QUARANTINED_EMBEDDINGS_FILE);
      this.quarantined = await loadPendingEmbeddings(this.root, QUARANTINED_EMBEDDINGS_FILE);
    }
    const durable = new Set(this.quarantined.map(e => e.pageId));
    const held = retiring.filter(e => !durable.has(e.pageId));
    // Retain overflow with its exhausted count; never retire an unpersisted exclusion.
    if (this.pending.length > 0) await writePendingEmbeddings(this.root, [...held, ...result.survivors]);
    warnQuarantined(result.quarantined);
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
