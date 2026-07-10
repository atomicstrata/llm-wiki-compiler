/**
 * @file src/utils/embeddings-refresh.ts
 * @description The SINGLE pending-marker-draining embeddings refresh both the
 * compiler and `review approve` route through, so the per-id write-ahead
 * lifecycle is never re-implemented (and never partially omitted) per call site.
 *
 * ## Why one shared drain
 * The compiler's post-write refresh and the `review approve` post-write refresh
 * are the SAME operation: union the freshly-changed page-ids into any prior
 * pending entries, write the intent ahead, run the lock-free embeddings core,
 * then settle the marker per-id (clear embedded, retain eligible-unembedded,
 * quarantine ineligible-over-cap). A separate review-approve refresh that only
 * called the core for the approved id NEVER drained the accumulated marker — so a
 * project run purely as `compile --review` + `review approve` leaked pending ids
 * that were never retried, leaving embeddings stale indefinitely. Folding both
 * onto this function closes that gap by construction.
 *
 * ## Lock precondition (caller MUST hold the project lock)
 * This calls {@link updateEmbeddingsLockedCore}, the LOCK-FREE core, NOT the
 * self-locking wrapper. Both call sites already hold `.llmwiki/lock` across the
 * call (compile for its whole pipeline; `review approve` via `runReviewUnderLock`),
 * so re-locking here would deadlock. Any new caller MUST likewise hold the lock.
 *
 * ## Non-fatal
 * Embeddings are a non-critical enhancement: a missing API key or a transient
 * provider error settles the marker for a retry and warns rather than throwing,
 * so an embeddings failure can never break a compile or an approval.
 */

import { updateEmbeddingsLockedCore } from "./embeddings.js";
import { handleSafeEmbeddingFailure } from "./embeddings-batch.js";
import { verbose } from "./output.js";
import type { PageId } from "./page-id.js";
import {
  loadPendingEmbeddings,
  writePendingEmbeddings,
  mergeFreshAttempts,
  settleAfterSuccess,
  settleAfterFailure,
  warnQuarantined,
} from "./pending-embeddings.js";

/**
 * Refresh embeddings for `changedPageIds` while DRAINING the durable pending
 * marker, then settle that marker per-id. The full write-ahead lifecycle:
 *
 *  1. Load the prior pending entries and UNION `changedPageIds` into them
 *     (preserving each existing entry's accumulated failed-attempt count).
 *  2. Record the merged set to the durable, root-confined write-ahead marker
 *     BEFORE the attempt, so a swallowed failure or crash leaves a retry list.
 *  3. Run {@link updateEmbeddingsLockedCore} (the LOCK-FREE core — see the
 *     file-level lock precondition).
 *  4a. On SUCCESS: {@link settleAfterSuccess} clears only the ids the core
 *      actually embedded; an eligible-but-unembedded id is retained, and an
 *      ineligible id over the attempt cap is quarantined. Survivors are written
 *      back (empty → marker deleted) and quarantined ids are warned.
 *  4b. On FAILURE: {@link settleAfterFailure} increments attempts for the whole
 *      batch, quarantining any over the cap; survivors written back, quarantined
 *      warned, and the failure is surfaced non-fatally.
 *
 * Returns early (no marker touched) when there is nothing to refresh.
 *
 * @param root - Absolute project root the marker is confined under.
 * @param changedPageIds - Qualified page-ids changed this run (may be empty —
 *   the prior pending entries are still drained).
 * @precondition The caller MUST hold the project lock across this call.
 */
export async function refreshEmbeddingsDrainingPending(
  root: string,
  changedPageIds: PageId[],
): Promise<void> {
  const merged = mergeFreshAttempts(await loadPendingEmbeddings(root), changedPageIds);
  const toRefresh = merged.map((entry) => entry.pageId);
  verbose(`embeddings: refreshing ${toRefresh.length} page-id(s)`);
  if (toRefresh.length === 0) return;
  // Write-ahead intent: record BEFORE the attempt so a swallowed failure or crash
  // leaves a durable retry list even though source-state already marks sources current.
  await writePendingEmbeddings(root, merged);
  try {
    const { embedded, eligible } = await updateEmbeddingsLockedCore(root, toRefresh);
    const settled = settleAfterSuccess(merged, embedded, eligible);
    await writePendingEmbeddings(root, settled.survivors);
    warnQuarantined(settled.quarantined);
  } catch (err) {
    const settled = settleAfterFailure(merged, toRefresh);
    await writePendingEmbeddings(root, settled.survivors);
    warnQuarantined(settled.quarantined);
    const message = err instanceof Error ? err.message : String(err);
    handleSafeEmbeddingFailure(err, `Skipped embeddings update: ${message}`);
  }
}
