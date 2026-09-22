/**
 * Commander action for `llmwiki review reject <id>`.
 *
 * Removes a candidate from the pending area without touching `wiki/`.
 * Rejected candidates are moved into .llmwiki/candidates/archive/ so they
 * remain auditable but never appear in `llmwiki review list` again.
 *
 * The archive mutation is performed under `.llmwiki/lock` to serialize
 * concurrent approve/reject and approve-vs-compile operations, matching
 * the lock discipline used by compile and approve.
 *
 * The candidate is re-read under the lock (TOCTOU guard) — if it disappears
 * between the pre-lock fast-fail and lock acquisition, the rejection aborts
 * cleanly rather than silently succeeding on a stale handle.
 */

import { archiveCandidate } from "../compiler/candidates.js";
import * as output from "../utils/output.js";
import { runReviewUnderLock, readCandidateUnderLock } from "./review-helpers.js";

/** Reject a pending candidate by archiving its JSON record. */
export default async function reviewRejectCommand(id: string): Promise<void> {
  await runReviewUnderLock(id, rejectUnderLock);
}

/**
 * Perform the archive mutation while holding the lock.
 *
 * Re-reads the candidate under the lock so that a concurrent approve that ran
 * between the pre-lock fast-fail and lock acquisition is detected. Aborts with
 * exit code 1 if the candidate has disappeared.
 */
async function rejectUnderLock(root: string, id: string): Promise<void> {
  const candidate = await readCandidateUnderLock(root, id);
  if (!candidate) return;

  let archived = false;
  try {
    archived = await archiveCandidate(root, id);
  } catch {
    archived = false;
  }
  if (!archived) {
    output.status("!", output.error("Candidate could not be archived safely."));
    process.exitCode = 1;
    return;
  }
  output.status(
    "-",
    output.warn(`Rejected candidate ${id} (${candidate.slug}) — archived, wiki unchanged.`),
  );
}
