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
 * Batch approval uses {@link refreshAffectedEmbeddings} instead: only approved
 * pages and collateral page rewrites may consume retry budgets or provider work.
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

import { updateEmbeddingsLockedCore, type EmbeddingRefreshScope } from "./embeddings.js";
import { handleSafeEmbeddingFailure } from "./embeddings-batch.js";
import { embeddingsDisabled } from "./embeddings-config.js";
import { ENV_EMBEDDINGS } from "./constants.js";
import { verbose } from "./output.js";
import type { PageId } from "./page-id.js";
import { loadEmbeddingRetry, loadScopedEmbeddingRetry } from "./embeddings-retry.js";

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
 *     Before any provider request, the core hands each page's content hash to
 *     the retry layer, which admits it (unless its unchanged content is still
 *     excluded) and pre-charges one attempt against that content.
 *  4. Settle exactly once, from what the attempt recorder saw: persisted pages
 *     are cleared; pages in a terminally failed request, or sent in a run that
 *     failed after all its requests succeeded, keep their charge (quarantined at
 *     the cap); everything else admitted is refunded; ineligible pages age out.
 *     A failure is surfaced non-fatally (strict mode rethrows).
 *
 * When no explicit or pending ids exist, the core still receives an empty
 * change set. Its content-hash migration discovers missing or stale vectors,
 * which makes the first enabled no-op compile reconcile pages written while
 * refreshes were disabled. A healthy store returns without provider calls or
 * writes. Discovered work is recorded before provider calls and shares the retry
 * limit; quarantined ids remain excluded until their content changes.
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
  await refreshEmbeddings(root, changedPageIds, "drain");
}

/** Refresh affected IDs; report whether all work was handed to durable retry state (or disabled). */
export async function refreshAffectedEmbeddings(root: string, affectedIds: PageId[]): Promise<boolean> {
  if (affectedIds.length === 0) return true;
  return refreshEmbeddings(root, affectedIds, "affected-only");
}

/** Share write-ahead and settlement behavior while selecting the reconciliation scope. */
async function refreshEmbeddings(root: string, changedPageIds: PageId[], scope: EmbeddingRefreshScope): Promise<boolean> {
  if (embeddingsDisabled()) {
    verbose(`embeddings: skipped because ${ENV_EMBEDDINGS} disables refreshes`);
    return true;
  }
  let retry: Awaited<ReturnType<typeof loadEmbeddingRetry>>;
  try {
    retry = await (scope === "drain" ? loadEmbeddingRetry : loadScopedEmbeddingRetry)(root, changedPageIds);
  } catch (error) {
    if (scope === "drain") throw error;
    handleSafeEmbeddingFailure(error, "Skipped embeddings update: retry state unavailable.");
    return false;
  }
  verbose(`embeddings: refreshing ${retry.pageIds.length} page-id(s)`);
  // Write-ahead intent: record BEFORE the attempt so a swallowed failure or crash
  // leaves a durable retry list even though source-state already marks sources current.
  await retry.recordPending();
  const failure = await attemptAndSettle(root, retry, scope);
  if (failure !== undefined) {
    const message = failure instanceof Error ? failure.message : String(failure);
    handleSafeEmbeddingFailure(failure, `Skipped embeddings update: ${message}`);
  }
  reportDeferredWork(retry.deferred);
  return retry.deferred.length === 0;
}

/**
 * Run the core, then settle exactly once from what it actually sent. A core
 * failure and a settlement failure are both reported, never settled twice.
 */
async function attemptAndSettle(
  root: string,
  retry: Awaited<ReturnType<typeof loadEmbeddingRetry>>,
  scope: EmbeddingRefreshScope,
): Promise<unknown> {
  let result: Awaited<ReturnType<typeof updateEmbeddingsLockedCore>> | undefined;
  let failure: unknown;
  try {
    result = await updateEmbeddingsLockedCore(root, retry.pageIds, (ids, hashes) => retry.prepare(ids, hashes), scope, retry.recorder);
  } catch (err) {
    failure = err;
  }
  try {
    await retry.settle(result);
  } catch (err) {
    failure ??= err;
  }
  return failure;
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
