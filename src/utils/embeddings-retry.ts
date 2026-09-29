/**
 * Durable retry bookkeeping for shared embedding refreshes. Automatically
 * discovered work uses the same attempt budget as explicit page changes.
 * Quarantined ids live separately from the active pending queue so an empty
 * queue cannot make reconciliation forget which pages exhausted their budget.
 *
 * Budgets and exclusions are bound to the content that was attempted (see
 * {@link decideRetry}): supplying an id never releases its exclusion, changed
 * content always does. Attempts are pre-charged before any provider request and
 * settled from what the {@link EmbeddingAttemptRecorder} saw. Every marker write
 * is re-read, because the writer swallows write and unlink failures.
 * The caller must hold the project lock throughout this lifecycle.
 */

import { MAX_PENDING_EMBEDDING_ATTEMPTS, QUARANTINED_EMBEDDINGS_FILE } from "./constants.js";
import { EmbeddingAttemptRecorder } from "./embedding-attempts.js";
import * as output from "./output.js";
import type { PageId } from "./page-id.js";
import {
  loadPendingEmbeddings,
  readPendingMarker,
  writePendingEmbeddings,
  mergeFreshAttempts,
  normalizeMarker,
  warnQuarantined,
  type PendingEmbedding,
} from "./pending-embeddings.js";
import { decideRetry, dropShadowedPending, fitAdmissions, settleRetry } from "./retry-exclusions.js";

type MarkerFile = Parameters<typeof writePendingEmbeddings>[2];

/** The core's report of a run that returned normally. */
interface CoreResult {
  embedded: PageId[];
  eligible: PageId[];
  pruned: PageId[];
}

/** Retry state shared between planning, provider execution, and settlement. */
class EmbeddingRetry {
  /** Eligible pages whose budgets could not be recorded, so they were not attempted. */
  deferred: PageId[] = [];
  /** Which pages this run actually sent, for settlement. */
  readonly recorder = new EmbeddingAttemptRecorder();
  private admitted = new Set<PageId>();
  private settled = false;

  /** Keep mutable state private to a single locked refresh. */
  constructor(
    private readonly root: string,
    private pending: PendingEmbedding[],
    private quarantined: PendingEmbedding[],
    private readonly changedIds: PageId[],
    private readonly scope?: ReadonlySet<PageId>,
  ) {
    this.pending = dropShadowedPending(pending, quarantined, id => this.includes(id));
  }

  /** Ids for the core: explicit changes plus in-scope pending work, including exclusions to re-check. */
  get pageIds(): PageId[] {
    return [...new Set([...this.changedIds, ...this.pending.map(e => e.pageId).filter(id => this.includes(id))])];
  }

  /** Record explicit work before even store discovery can fail; never release an exclusion here. */
  async recordPending(): Promise<void> {
    const prior = await readPendingMarker(this.root);
    const merged = withFreshWork(this.pending, this.quarantined, this.changedIds, this.scope !== undefined);
    if (merged.length > 0 || prior.status === "ok") await writePendingEmbeddings(this.root, merged);
    // The writer applies both resource caps. Never attempt work it dropped.
    this.pending = await loadPendingEmbeddings(this.root);
    if (this.scope) this.deferred = unrecorded([...this.scope], this.pending, this.quarantined);
  }

  /** Decide each page by content hash, pre-charge the admitted ones, and verify before any request. */
  async prepare(ids: PageId[], hashes: ReadonlyMap<PageId, string>): Promise<PageId[]> {
    const decisions = this.decide(ids, hashes);
    const fit = fitAdmissions(this.pending, decisions.map(d => d.entry));
    this.deferred = [...new Set([...this.deferred, ...fit.deferred])];
    if (fit.admitted.length === 0) return [];
    if (!(await writeVerified(this.root, fit.entries, undefined))) {
      this.deferred = [...new Set([...this.deferred, ...fit.admitted.map(e => e.pageId)])];
      return [];
    }
    this.pending = fit.entries;
    const admittedIds = new Set(fit.admitted.map(e => e.pageId));
    await this.removeStaleQuarantine(decisions.filter(d => d.releasesQuarantine && admittedIds.has(d.entry.pageId)));
    announceLegacyGrants(decisions.filter(d => d.legacyGrant && admittedIds.has(d.entry.pageId)).length);
    this.admitted = admittedIds;
    return [...admittedIds];
  }

  /** Settle exactly once from what was actually sent; a throw here is never followed by a second settle. */
  async settle(result: CoreResult | undefined): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    const { pending, quarantine } = settleRetry({
      pending: this.pending,
      admitted: this.admitted,
      outcome: this.recorder.outcome(),
      sentPages: this.recorder.sentPages,
      eligible: result ? new Set(result.eligible) : null,
      embedded: new Set(result?.embedded ?? []),
      pruned: new Set(result?.pruned ?? []),
      inScope: id => this.includes(id),
    });
    const retired = await this.retire(quarantine);
    const held = quarantine.filter(e => !retired.has(e.pageId));
    if (!(await writeVerified(this.root, [...pending, ...held], undefined))) {
      throw new Error("Embedding retry state could not be settled; attempt counts may be stale.");
    }
    warnQuarantined(quarantine.filter(e => retired.has(e.pageId)));
  }

  /** Admitted pages with their decisions; excluded pages are skipped silently, as before. */
  private decide(ids: PageId[], hashes: ReadonlyMap<PageId, string>) {
    const quarantined = new Map(this.quarantined.map(e => [e.pageId, e]));
    const pending = new Map(this.pending.map(e => [e.pageId, e]));
    return ids.filter(id => this.includes(id) && hashes.has(id)).flatMap(id => {
      const decision = decideRetry(id, hashes.get(id)!, quarantined.get(id), pending.get(id));
      return decision.kind === "admit" ? [decision] : [];
    });
  }

  /** Complete a release: the charged pending entry is already durable, so a failure here only warns. */
  private async removeStaleQuarantine(released: { entry: PendingEmbedding }[]): Promise<void> {
    if (released.length === 0) return;
    const ids = new Set(released.map(d => d.entry.pageId));
    const kept = this.quarantined.filter(e => !ids.has(e.pageId));
    if (await writeVerified(this.root, kept, QUARANTINED_EMBEDDINGS_FILE)) this.quarantined = kept;
    else output.status("!", output.warn("Could not remove released pages from the embedding quarantine; the next refresh completes it."));
  }

  /** Persist new exclusions before removing them from pending; return those that are durable. */
  private async retire(entries: PendingEmbedding[]): Promise<Set<PageId>> {
    if (entries.length === 0) return new Set();
    const ids = new Set(entries.map(e => e.pageId));
    const next = [...this.quarantined.filter(e => !ids.has(e.pageId)), ...entries];
    await writePendingEmbeddings(this.root, next, QUARANTINED_EMBEDDINGS_FILE);
    this.quarantined = await loadPendingEmbeddings(this.root, QUARANTINED_EMBEDDINGS_FILE);
    const durable = new Map(this.quarantined.map(e => [e.pageId, e]));
    // Retain overflow in pending with its exhausted count; never retire an unpersisted exclusion.
    return new Set(entries.filter(e => durable.get(e.pageId)?.contentHash === e.contentHash).map(e => e.pageId));
  }

  /** Restrict batch reconciliation without changing the compiler's full-drain default. */
  private includes(id: PageId): boolean {
    return this.scope === undefined || this.scope.has(id);
  }
}

/**
 * Add explicit work as fresh entries without touching exclusions. A drain puts
 * charged budgets and fresh ids ahead of uncharged backlog; a scoped caller keeps
 * every existing entry first so the caps cannot evict unrelated ids.
 */
function withFreshWork(
  pending: PendingEmbedding[],
  quarantined: PendingEmbedding[],
  changedIds: PageId[],
  scoped: boolean,
): PendingEmbedding[] {
  const blocked = new Set(quarantined.map(e => e.pageId));
  const fresh = changedIds.filter(id => !blocked.has(id));
  const first = scoped ? pending.map(e => e.pageId) : pending.filter(e => e.attempts > 0).map(e => e.pageId);
  return mergeFreshAttempts(pending, [...first, ...fresh]);
}

/** Ids neither queued nor durably excluded; an exclusion is re-checked by content at the next refresh. */
function unrecorded(ids: PageId[], pending: PendingEmbedding[], quarantined: PendingEmbedding[]): PageId[] {
  const handled = new Set([...pending, ...quarantined].map(e => e.pageId));
  return [...new Set(ids)].filter(id => !handled.has(id));
}

/** Write a marker and confirm the persisted result is exactly what was intended. */
async function writeVerified(root: string, entries: PendingEmbedding[], file: MarkerFile): Promise<boolean> {
  const intended = JSON.stringify(normalizeMarker(entries));
  await writePendingEmbeddings(root, entries, file);
  const read = await readPendingMarker(root, file);
  return read.status !== "unavailable" && JSON.stringify(read.entries) === intended;
}

/** Tell the user once per run that exclusions from before content hashing were re-queued. */
function announceLegacyGrants(count: number): void {
  if (count === 0) return;
  output.status("!", output.warn(
    `${count} previously quarantined page(s) re-queued after upgrade ` +
    `(up to ${MAX_PENDING_EMBEDDING_ATTEMPTS} additional retry rounds each).`,
  ));
}

/** Load an affected-only retry set, retaining unrelated budgets and exclusions verbatim. */
export async function loadScopedEmbeddingRetry(root: string, affectedIds: PageId[]): Promise<EmbeddingRetry> {
  const { pending, quarantined } = await readScopedRetryState(root);
  return new EmbeddingRetry(root, pending, quarantined, affectedIds, new Set(affectedIds));
}

/**
 * Affected IDs a scoped refresh could not record in the retry marker, computed
 * with the refresh's own merge and the marker's own caps, without writing.
 * Batch approval checks this before promoting pages, so a full marker refuses
 * the batch up front instead of failing after pages are already live.
 */
export async function unrecordableScopedIds(root: string, affectedIds: PageId[]): Promise<PageId[]> {
  const { pending, quarantined } = await readScopedRetryState(root);
  const recorded = normalizeMarker(withFreshWork(pending, quarantined, affectedIds, true));
  return unrecorded(affectedIds, recorded, quarantined);
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

/**
 * Durably hand affected IDs to the next refresh without attempting them. Each id
 * ends up queued, or stays under an existing exclusion, which that refresh
 * re-checks by content. Returns the ids the marker could not record, so callers
 * can refuse rather than drop work.
 */
export async function queueScopedEmbeddingRetry(root: string, affectedIds: PageId[]): Promise<PageId[]> {
  const retry = await loadScopedEmbeddingRetry(root, affectedIds);
  await retry.recordPending();
  return retry.deferred;
}

/** Load retry state for a full drain; markers are read fail-open, as before. */
export async function loadEmbeddingRetry(root: string, changedPageIds: PageId[]): Promise<EmbeddingRetry> {
  const [pending, quarantined] = await Promise.all([
    loadPendingEmbeddings(root), loadPendingEmbeddings(root, QUARANTINED_EMBEDDINGS_FILE),
  ]);
  return new EmbeddingRetry(root, pending, quarantined, changedPageIds);
}
