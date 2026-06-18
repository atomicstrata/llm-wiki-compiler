/**
 * @file src/trust/executor.ts
 * @description The guarded PAGE EXECUTOR — the only path that turns an approved
 * {@link PlannedMutation} plan into bytes on disk, under the CLP atomicity
 * contract ("partial application of an approved batch is a bug").
 *
 * {@link applyApprovedMutations} runs the batch behind the project lock and a
 * single-store intent journal:
 *  1. acquire the PID-based project lock (same discipline as compile/review);
 *  2. open a journal batch and record EVERY target's pre-state before any write;
 *  3. apply each `page` mutation via {@link atomicWrite} (temp-then-rename);
 *  4. commit the journal once all writes land;
 *  5. release the lock in `finally`.
 *
 * If any write throws mid-batch, the journal stays `pending` (uncommitted), so a
 * subsequent {@link replayJournal} reverts the whole batch to its pre-state — no
 * partial post-state ever survives. Every write target is confined under the
 * project root via {@link confineUnderRoot} before it is touched.
 *
 * SCOPE: Task 5 executes `kind:"page"` only. Any other {@link MutationKind} is
 * rejected with a typed `not-implemented` error, so an unhandled store can never
 * be silently no-op'd or half-applied.
 */

import path from "path";
import { acquireLock, releaseLock } from "../utils/lock.js";
import { atomicWrite } from "../utils/markdown.js";
import { confineUnderRoot } from "../utils/path-confine.js";
import { openBatch, recordPreState, commitBatch, type JournalBatch } from "./journal.js";
import type { PlannedMutation } from "./planner.js";

/** A single page write. Injectable so tests can fault-inject a failure. */
export type WriteOne = (filePath: string, content: string) => Promise<void>;

/** Options for {@link applyApprovedMutations}; `writeOne` defaults to atomicWrite. */
export interface ApplyOptions {
  /** Per-target write primitive (defaults to {@link atomicWrite}). */
  writeOne?: WriteOne;
}

/**
 * Error thrown when a mutation targets a store the executor does not handle.
 * Module-private: callers match on the typed `not-implemented:` message prefix
 * (the stable contract) rather than the class, so the class need not be exported.
 */
class NotImplementedMutationError extends Error {
  constructor(kind: string) {
    super(`not-implemented: executor does not handle mutation kind "${kind}"`);
    this.name = "NotImplementedMutationError";
  }
}

/** The wiki-relative page path for a page mutation's target. */
function pageRelPath(mutation: PlannedMutation): string {
  const { entityType, slug } = mutation.target;
  return path.join("wiki", entityType, `${slug}.md`);
}

/**
 * Apply every page mutation in the batch under an already-open journal: record
 * each target's pre-state, then write it. Throws on the first non-page kind or
 * the first failing write, leaving the journal uncommitted for replay.
 */
async function applyBatch(
  root: string,
  planned: PlannedMutation[],
  batch: JournalBatch,
  writeOne: WriteOne,
): Promise<void> {
  for (const mutation of planned) {
    if (mutation.kind !== "page") throw new NotImplementedMutationError(mutation.kind);
    const abs = await confineUnderRoot(pageRelPath(mutation), root, { mustExist: false });
    await recordPreState(batch, abs);
    await writeOne(abs, mutation.body);
  }
}

/**
 * Apply an approved plan to disk atomically. Acquires the project lock, journals
 * every target's pre-state before writing, applies each page mutation, then
 * commits the journal — releasing the lock in `finally`. A non-page kind throws
 * `not-implemented`. A mid-batch failure leaves a `pending` journal for
 * {@link replayJournal} to revert to the full pre-state.
 *
 * @param root - Absolute project root.
 * @param planned - The approved mutations to apply.
 * @param opts - Optional injectable write primitive (for fault injection).
 */
export async function applyApprovedMutations(
  root: string,
  planned: PlannedMutation[],
  opts: ApplyOptions = {},
): Promise<void> {
  const writeOne = opts.writeOne ?? atomicWrite;
  const acquired = await acquireLock(root);
  if (!acquired) throw new Error("could not acquire project lock for mutation batch");
  try {
    const batch = await openBatch(root);
    await applyBatch(root, planned, batch, writeOne);
    await commitBatch(batch);
  } finally {
    await releaseLock(root);
  }
}
