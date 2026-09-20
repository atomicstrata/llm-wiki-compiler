/**
 * Shared helpers for review subcommands (approve and reject).
 *
 * Both commands follow the same pattern:
 *   1. Fast-fail: read the candidate before locking (cheap early exit for bad ids).
 *   2. Acquire lock: serialize against concurrent compile / approve / reject.
 *   3. Under-lock re-read: authoritative TOCTOU guard — abort if the candidate
 *      was removed between steps 1 and 2 (e.g. a concurrent reject ran first).
 *   4. Run the mutation.
 *   5. Release lock.
 *
 * Extracting this pattern avoids duplicating the acquire/release boilerplate
 * in both approve and reject.
 */

import {
  loadCandidateOrFail,
  loadCandidateUnderLockOrFail,
} from "../compiler/candidates.js";
import { releaseLock } from "../utils/lock.js";
import { acquireMutationLock } from "../operation-bundles/lock-gate.js";
import * as output from "../utils/output.js";

/** Re-export for use by the under-lock mutation functions in approve/reject. */
export { loadCandidateUnderLockOrFail as readCandidateUnderLock };

/**
 * Run a review mutation under the `.llmwiki/lock`.
 *
 * Performs the pre-lock fast-fail, acquires the lock, then delegates to the
 * provided `underLock` callback. The lock is released in a `finally` block.
 *
 * @param id - Candidate id to review.
 * @param underLock - Async mutation to run while holding the lock.
 * @param precheck - Admission for approval, or confined raw-file access for rejection.
 */
export async function runReviewUnderLock(
  id: string,
  underLock: (root: string, id: string) => Promise<void>,
  precheck: (root: string, id: string) => Promise<unknown> = loadCandidateOrFail,
): Promise<void> {
  const root = process.cwd();

  // Fast-fail: surface a clear error for obviously missing ids.
  // The callback repeats its admitted or raw-file check under the lock.
  const preCheck = await precheck(root, id);
  if (!preCheck) return;

  const locked = await acquireMutationLock(root, "review");
  if (!locked) {
    output.status("!", output.error("Could not acquire lock. Try again later."));
    process.exitCode = 1;
    return;
  }

  try {
    await underLock(root, id);
  } finally {
    await releaseLock(root);
  }
}
