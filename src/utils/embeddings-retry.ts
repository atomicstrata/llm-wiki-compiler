/**
 * Durable retry bookkeeping for shared embedding refreshes. Automatically
 * discovered work uses the same attempt budget as explicit page changes.
 * Quarantined ids live separately from the active pending queue so an empty
 * queue cannot make reconciliation forget which pages exhausted their budget.
 * The caller must hold the project lock throughout this lifecycle.
 */

import { QUARANTINED_EMBEDDINGS_FILE } from "./constants.js";
import type { PageId } from "./page-id.js";
import {
  loadPendingEmbeddings,
  writePendingEmbeddings,
  mergeFreshAttempts,
  settleAfterSuccess,
  settleAfterFailure,
  warnQuarantined,
  type PendingEmbedding,
  type SettleResult,
} from "./pending-embeddings.js";

/** Retry state shared between planning, provider execution, and settlement. */
class EmbeddingRetry {
  /** Keep mutable state private to a single locked refresh. */
  constructor(
    private readonly root: string,
    private pending: PendingEmbedding[],
    private quarantined: PendingEmbedding[],
  ) {}

  /** Page ids already waiting for an attempt, including temporarily ineligible ids. */
  get pageIds(): PageId[] {
    return this.pending.map((entry) => entry.pageId);
  }

  /** Record explicit work before even store discovery can fail. */
  async recordPending(): Promise<void> {
    if (this.pending.length > 0) await writePendingEmbeddings(this.root, this.pending);
  }

  /** Add discovered work to the budget while excluding durable quarantines. */
  async prepare(discovered: PageId[]): Promise<PageId[]> {
    const blocked = new Set(this.quarantined.map((entry) => entry.pageId));
    const allowed = discovered.filter((id) => !blocked.has(id));
    // Keep explicit changes ahead of discovered backlog when the marker is capped.
    this.pending = mergeFreshAttempts(this.pending, [...this.pageIds, ...allowed]);
    await this.recordPending();
    return allowed;
  }

  /** Clear completed work and age temporarily ineligible entries. */
  async succeed(embedded: PageId[], eligible: PageId[]): Promise<void> {
    await this.settle(settleAfterSuccess(this.pending, embedded, eligible));
  }

  /** Count failures for explicit and automatically discovered work alike. */
  async fail(): Promise<void> {
    await this.settle(settleAfterFailure(this.pending, this.pageIds));
  }

  /** Persist exclusions before removing active entries, then report new quarantines. */
  private async settle(result: SettleResult): Promise<void> {
    if (result.quarantined.length > 0) {
      this.quarantined.push(...result.quarantined);
      await writePendingEmbeddings(this.root, this.quarantined, QUARANTINED_EMBEDDINGS_FILE);
    }
    if (this.pending.length > 0) await writePendingEmbeddings(this.root, result.survivors);
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
  const pending = (await loadPendingEmbeddings(root)).filter((entry) => !blocked.has(entry.pageId));
  return new EmbeddingRetry(root, mergeFreshAttempts(pending, changedPageIds), quarantined);
}
