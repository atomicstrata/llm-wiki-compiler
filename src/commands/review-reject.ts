/**
 * @file src/commands/review-reject.ts
 * @description The `review reject` subcommand: archives a pending candidate
 * without touching `wiki/`.
 *
 * Rejection reads the candidate's raw queue file by its explicit safe id and
 * never runs promotion admission, so a record with malformed validated-answer
 * metadata can still be cleared. The archive move runs under the review lock
 * and re-captures custody immediately before moving, so a candidate that was
 * removed or replaced between the pre-lock check and the move fails cleanly
 * rather than silently succeeding on a stale handle.
 *
 * A candidate retained by an interrupted batch may key embedding work in the
 * review intent. Before archiving, that work is handed to the embedding retry
 * queue, keyed from the same captured bytes the move archives; if the queue
 * cannot record it, or either store is unreadable, the rejection refuses and
 * the candidate stays pending.
 */

import { archiveRejectedCandidate, loadRejectableCandidateOrFail } from "../compiler/candidate-rejection.js";
import { embeddingsDisabled } from "../utils/embeddings-config.js";
import { queueScopedEmbeddingRetry, releaseScopedExclusions } from "../utils/embeddings-retry.js";
import * as output from "../utils/output.js";
import type { PageId } from "../utils/page-id.js";
import { releaseRejectedIntent } from "./review-embedding-intent.js";
import { runReviewUnderLock } from "./review-helpers.js";

/** Reject a pending candidate by archiving its JSON record. */
export default async function reviewRejectCommand(id: string): Promise<void> {
  await runReviewUnderLock(id, rejectUnderLock, loadRejectableCandidateOrFail);
}

/** Archive the candidate while holding the lock; the helper reports every refusal. */
async function rejectUnderLock(root: string, id: string): Promise<void> {
  const released = await archiveRejectedCandidate(root, id, bytes =>
    releaseRejectedIntent(root, bytes, pageIds => handOffEmbeddingWork(root, pageIds)));
  if (!released) return;
  output.status(
    "-",
    output.warn(`Rejected candidate ${id} — archived, wiki unchanged.`),
  );
}

/**
 * Queue released pages like a finished batch would. Disabled refreshes queue
 * nothing, but still lift their exclusions so a later enabled compile can re-find them.
 */
async function handOffEmbeddingWork(root: string, pageIds: PageId[]): Promise<void> {
  if (pageIds.length === 0) return;
  if (embeddingsDisabled()) return releaseScopedExclusions(root, pageIds);
  const unrecorded = await queueScopedEmbeddingRetry(root, pageIds);
  if (unrecorded.length === 0) return;
  throw new Error(
    `Embedding retry queue is full: ${unrecorded.length} page(s) from an interrupted batch could not be queued. ` +
    "Run `llmwiki compile` to work through queued embeddings, then retry; the candidate was not rejected.",
  );
}
