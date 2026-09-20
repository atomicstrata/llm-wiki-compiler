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
 */

import { archiveRejectedCandidate, loadRejectableCandidateOrFail } from "../compiler/candidate-rejection.js";
import * as output from "../utils/output.js";
import { runReviewUnderLock } from "./review-helpers.js";

/** Reject a pending candidate by archiving its JSON record. */
export default async function reviewRejectCommand(id: string): Promise<void> {
  await runReviewUnderLock(id, rejectUnderLock, loadRejectableCandidateOrFail);
}

/** Archive the candidate while holding the lock; the helper reports every refusal. */
async function rejectUnderLock(root: string, id: string): Promise<void> {
  if (!await archiveRejectedCandidate(root, id)) return;
  output.status(
    "-",
    output.warn(`Rejected candidate ${id} — archived, wiki unchanged.`),
  );
}
