/**
 * @file src/utils/embedding-attempts.ts
 * @description Records which pages an embedding refresh actually sent to the
 * provider, so retry budgets charge real attempts rather than everything that
 * was merely prepared.
 *
 * The batch layer reports each provider request (a native batch call or one
 * single-item fallback, including its response validation) as it is sent,
 * succeeds, or fails. A request that fails and is not followed by another
 * request is the one that ended the run: an embedding run either retries after
 * a failure or propagates it immediately. The recorder lives with the retry
 * state, so it survives the core throwing and settlement can classify the run:
 *
 * - `persisted`: the store write completed; every sent page is done.
 * - `request-failed`: a request failed terminally; only its pages are charged,
 *   and pages sent earlier are refunded because they were not at fault.
 * - `after-requests`: every request succeeded but the run failed afterwards
 *   (for example, the store write). Sent pages keep their charge, so a
 *   persistent failure after paid work cannot repeat forever.
 * - `before-requests`: nothing was sent, so nobody is charged.
 */

import type { PageId } from "./page-id.js";

/** Batch-layer view of one run: work-item indices, mapped to pages by the pass. */
export interface EmbeddingRequestObserver {
  sending(indices: number[]): void;
  succeeded(indices: number[]): void;
  failed(indices: number[]): void;
}

/** How a refresh that may have contacted the provider ended. */
export type EmbeddingRunOutcome =
  | { kind: "persisted" }
  | { kind: "request-failed"; failed: ReadonlySet<PageId> }
  | { kind: "after-requests" }
  | { kind: "before-requests" };

/** Per-run record of sent pages and the last failed request. */
export class EmbeddingAttemptRecorder {
  private readonly sent = new Set<PageId>();
  private lastFailed: PageId[] | null = null;
  private persisted = false;

  /** Pages whose content reached the provider in at least one request. */
  get sentPages(): ReadonlySet<PageId> {
    return this.sent;
  }

  /** Adapt the recorder to one pass, whose work items map to pages by index. */
  observe(pageAt: (index: number) => PageId | undefined): EmbeddingRequestObserver {
    const pages = (indices: number[]): PageId[] =>
      [...new Set(indices.map(pageAt).filter((id): id is PageId => id !== undefined))];
    return {
      sending: indices => { for (const id of pages(indices)) this.sent.add(id); },
      succeeded: () => { this.lastFailed = null; },
      failed: indices => { this.lastFailed = pages(indices); },
    };
  }

  /** The store write for this run's embeddings completed. */
  markPersisted(): void {
    this.persisted = true;
  }

  /** Classify a run that returned normally or threw. */
  outcome(): EmbeddingRunOutcome {
    if (this.persisted) return { kind: "persisted" };
    if (this.sent.size === 0) return { kind: "before-requests" };
    if (this.lastFailed !== null) return { kind: "request-failed", failed: new Set(this.lastFailed) };
    return { kind: "after-requests" };
  }
}
