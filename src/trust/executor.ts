/**
 * @file src/trust/executor.ts
 * @description The guarded PAGE EXECUTOR — turns an approved
 * {@link PlannedMutation} plan into bytes on disk, under the CLP atomicity
 * contract ("partial application of an approved batch is a bug").
 *
 * STATUS: this planner/executor/journal seam is a Phase-2 FOUNDATION. No live
 * production write path routes through it yet (no caller invokes
 * {@link applyApprovedMutations}); the atomicity contract is realized for the
 * page store in isolation and under test, not yet across any wired surface.
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
import { lstat } from "fs/promises";
import { acquireLock, releaseLock } from "../utils/lock.js";
import { atomicWrite } from "../utils/markdown.js";
import { confineUnderRoot } from "../utils/path-confine.js";
import {
  openBatch,
  recordPreState,
  commitBatch,
  replayJournal,
  type JournalBatch,
} from "./journal.js";
import { parseEntityId } from "../profile/identity.js";
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

/**
 * Thrown when a `create` target — free at plan time — has appeared on disk by
 * the time the batch runs under the lock. Aborting before any write closes the
 * plan→apply TOCTOU so a create never clobbers a concurrently-created file.
 * Callers match on the typed `create-collision:` message prefix.
 */
class CreateCollisionError extends Error {
  constructor(targetPath: string) {
    super(`create-collision: target already exists, refusing to overwrite: ${targetPath}`);
    this.name = "CreateCollisionError";
  }
}

/**
 * Thrown when a mutation's target identity is not slug-safe. The planner's
 * `checkIdentitySafe` guard only protects the planner path; a hand-built
 * {@link PlannedMutation} bypasses it, so the executor re-asserts the identity
 * before deriving a path. Callers match on the typed `invalid-identity:` prefix.
 */
class InvalidIdentityError extends Error {
  constructor(message: string) {
    super(`invalid-identity: ${message}`);
    this.name = "InvalidIdentityError";
  }
}

/** True when something exists at `abs` (regular file, dir, or symlink). */
async function targetExists(abs: string): Promise<boolean> {
  try {
    await lstat(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * The wiki-relative page path for a page mutation's target.
 *
 * Defense-in-depth: the entityType/slug are re-validated by re-parsing the
 * branded `target.id` (which throws on a non-slug-safe slug half), so a
 * hand-built mutation carrying a `..` slug is rejected with a typed
 * {@link InvalidIdentityError} BEFORE `path.join` could collapse it into a wrong
 * in-root location — the planner's `checkIdentitySafe` guard is not on this path.
 */
function pageRelPath(mutation: PlannedMutation): string {
  let entityType: string;
  let slug: string;
  try {
    ({ entityType, slug } = parseEntityId(mutation.target.id));
  } catch (err) {
    throw new InvalidIdentityError((err as Error).message);
  }
  return path.join("wiki", entityType, `${slug}.md`);
}

/**
 * Apply every page mutation in the batch under an already-open journal: record
 * each target's pre-state, then write it. Throws on the first non-page kind or
 * the first failing write, leaving the journal uncommitted for replay.
 *
 * A `create` target is RE-PROBED under the lock (the planner's collision check
 * runs before the lock): if it now exists, abort with {@link CreateCollisionError}
 * BEFORE any write lands, so a create never overwrites a file that appeared
 * after planning. `update` operations may legitimately overwrite.
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
    if (mutation.operation === "create" && (await targetExists(abs))) {
      throw new CreateCollisionError(abs);
    }
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
 * Self-recovery: BEFORE opening the new batch (but AFTER the lock is held), it
 * runs {@link replayJournal}, so a `pending` journal left dangling by a prior
 * crash is reverted under the same lock before this batch begins — the atomicity
 * guarantee no longer depends on an external caller invoking replay.
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
    // Recover any dangling pending batch from a prior crash under the held lock.
    await replayJournal(root);
    const batch = await openBatch(root);
    await applyBatch(root, planned, batch, writeOne);
    await commitBatch(batch);
  } finally {
    await releaseLock(root);
  }
}
