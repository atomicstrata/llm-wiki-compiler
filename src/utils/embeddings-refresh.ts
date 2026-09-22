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
 * provider error settles the marker for a retry and warns. Strict embedding mode
 * rethrows after settlement so automation can detect a broken provider.
 */

import { updateEmbeddingsLockedCore } from "./embeddings.js";
import { handleSafeEmbeddingFailure } from "./embeddings-batch.js";
import { embeddingsDisabled } from "./embeddings-config.js";
import { ENV_EMBEDDINGS } from "./constants.js";
import { verbose } from "./output.js";
import type { PageId } from "./page-id.js";
import { loadEmbeddingRetry } from "./embeddings-retry.js";

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
 * When no explicit or pending ids exist, the core still receives an empty
 * change set. Its content-hash migration discovers missing or stale vectors,
 * which makes the first enabled no-op compile reconcile pages written while
 * refreshes were disabled. A healthy store returns without provider calls or
 * writes. Discovered work is recorded before provider calls and shares the retry
 * limit; quarantined ids remain excluded until an explicit page change.
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
  if (embeddingsDisabled()) {
    verbose(`embeddings: skipped because ${ENV_EMBEDDINGS} disables refreshes`);
    return;
  }
  const retry = await loadEmbeddingRetry(root, changedPageIds);
  verbose(`embeddings: refreshing ${retry.pageIds.length} page-id(s)`);
  // Write-ahead intent: record BEFORE the attempt so a swallowed failure or crash
  // leaves a durable retry list even though source-state already marks sources current.
  await retry.recordPending();
  try {
    const { embedded, eligible, pruned } = await updateEmbeddingsLockedCore(
      root, retry.pageIds, (ids) => retry.prepare(ids),
    );
    await retry.succeed([...embedded, ...pruned], eligible);
  } catch (err) {
    await retry.fail();
    const message = err instanceof Error ? err.message : String(err);
    handleSafeEmbeddingFailure(err, `Skipped embeddings update: ${message}`);
  }
  reportDeferredWork(retry.deferred);
}

/** Report after settlement, so strict-mode deferral cannot charge successful work again. */
function reportDeferredWork(deferred: PageId[]): void {
  if (deferred.length === 0) return;
  const MAX_WARNING_IDS = 10;
  const ids = deferred.length <= MAX_WARNING_IDS ? ` (${deferred.join(", ")})` : "";
  const message = `${deferred.length} page(s) deferred${ids}: embedding retry marker at capacity or unavailable. ` +
    "Free retry-marker capacity or fix marker storage, then run compile again; these pages were not attempted.";
  handleSafeEmbeddingFailure(new Error(message), message);
}
