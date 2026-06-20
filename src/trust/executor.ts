/**
 * @file src/trust/executor.ts
 * @description The guarded PAGE EXECUTOR — turns an approved
 * {@link PlannedMutation} plan into bytes on disk, under the CLP atomicity
 * contract ("partial application of an approved batch is a bug").
 *
 * STATUS: the `review approve` page write is the FIRST production consumer of
 * this seam — it routes through {@link applyApprovedMutationsLocked} under its
 * already-held review lock. The atomicity contract (and journal replay) is now
 * realized on that live path; other CLP write surfaces are still future work.
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
 *
 * S5 — FULL-FLOOR RE-ASSERTION AT APPLY: the executor is where bytes hit disk,
 * so it does not trust that plan-time checks still hold. Before every write it
 * re-runs the mandatory floor (resource-limit + frontmatter; path-confinement is
 * already enforced via {@link confineUnderRoot} and collision via the `create`
 * re-probe) against a context whose `allowOverwrite` reflects the mutation's
 * operation, and composes a {@link TrustDecision}. A non-allow decision throws a
 * typed {@link MutationFloorError} and writes NOTHING — a hand-built mutation
 * that bypassed the planner cannot smuggle an oversized or malformed body past.
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
import { parseEntityId, isSafeFilenameComponent } from "../profile/identity.js";
import { checkResourceLimit, checkFrontmatter, type PageWriteContext } from "./checks.js";
import { composeTrustDecision } from "./decision.js";
import type { PlannedMutation, EntityRef, RawPageRef } from "./planner.js";

/** Decisions under which the executor is cleared to write bytes to disk. */
const APPLY_ALLOWED_DECISIONS = new Set(["allow", "allow-with-warning"]);

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

/**
 * Thrown when a mutation fails the mandatory trust floor re-asserted at apply
 * time (S5): an oversized body, malformed frontmatter, or any block-composing
 * floor result. Refusing here — at the byte-writing boundary — means a
 * hand-built mutation that never passed the planner cannot reach disk. Callers
 * match on the typed `mutation-floor:` message prefix.
 */
class MutationFloorError extends Error {
  constructor(reason: string) {
    super(`mutation-floor: refused before write: ${reason}`);
    this.name = "MutationFloorError";
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
 * The wiki-relative page path for a DEFAULT page's {@link RawPageRef} target.
 *
 * Defense-in-depth: the executor does not trust the caller, so it RE-ASSERTS the
 * {@link isSafeFilenameComponent} floor on both the directory and the raw slug —
 * a hand-built mutation carrying a `..`/separator slug is rejected with a typed
 * {@link InvalidIdentityError} BEFORE `path.join` could collapse it into a wrong
 * in-root location (the planner's `checkDefaultIdentitySafe` guard is not on this
 * path).
 */
function rawPageRelPath(target: RawPageRef): string {
  if (!isSafeFilenameComponent(target.directory) || !isSafeFilenameComponent(target.slug)) {
    throw new InvalidIdentityError(`directory/slug is not a safe filename component: ${target.directory}/${target.slug}`);
  }
  return path.join("wiki", target.directory, `${target.slug}.md`);
}

/**
 * The wiki-relative page path for a PROFILE entity's {@link EntityRef} target.
 *
 * Defense-in-depth: the entityType/slug are re-validated by re-parsing the
 * branded `target.id` (which throws on a non-slug-safe slug half), so a
 * hand-built mutation carrying a `..` slug is rejected with a typed
 * {@link InvalidIdentityError} BEFORE `path.join` could collapse it into a wrong
 * in-root location — the planner's `checkIdentitySafe` guard is not on this path.
 */
function entityPageRelPath(target: EntityRef): string {
  let entityType: string;
  let slug: string;
  try {
    ({ entityType, slug } = parseEntityId(target.id));
  } catch (err) {
    throw new InvalidIdentityError((err as Error).message);
  }
  return path.join("wiki", entityType, `${slug}.md`);
}

/**
 * The wiki-relative page path for a page mutation's target, discriminating the
 * union: a DEFAULT page ({@link RawPageRef}, no `id`) takes the raw-component
 * path; a PROFILE entity ({@link EntityRef}) takes the typed-id path. Both
 * re-assert their identity floor as defense-in-depth.
 */
function pageRelPath(mutation: PlannedMutation): string {
  const target = mutation.target;
  if ("id" in target) return entityPageRelPath(target);
  return rawPageRelPath(target);
}

/**
 * Re-assert the mandatory trust floor for one mutation at apply time (S5),
 * against a context whose `allowOverwrite` mirrors the operation (`update`
 * overwrites; `create` does not). Runs the floor checks not already enforced on
 * this path — resource-limit and frontmatter — and composes them; a non-allow
 * decision throws {@link MutationFloorError} so nothing is written.
 */
async function assertFloorAtApply(root: string, mutation: PlannedMutation, abs: string): Promise<void> {
  const ctx: PageWriteContext = {
    root,
    targetPath: abs,
    body: mutation.body,
    allowOverwrite: mutation.operation === "update",
  };
  const checks = await Promise.all([checkResourceLimit(ctx), checkFrontmatter(ctx)]);
  const decision = composeTrustDecision(checks, { reviewRouted: false });
  if (!APPLY_ALLOWED_DECISIONS.has(decision)) {
    const reason = checks.find((c) => c.verdict === "block")?.message ?? decision;
    throw new MutationFloorError(reason);
  }
}

/**
 * Apply every page mutation in the batch under an already-open journal:
 * re-assert the trust floor (S5), record each target's pre-state, then write it.
 * Throws on the first non-page kind, floor violation, or failing write, leaving
 * the journal uncommitted for replay.
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
    await assertFloorAtApply(root, mutation, abs);
    await recordPreState(batch, abs);
    await writeOne(abs, mutation.body);
  }
}

/**
 * Apply an approved plan to disk atomically WHILE THE CALLER ALREADY HOLDS the
 * project lock — the lock-free core shared with {@link applyApprovedMutations}.
 *
 * The caller MUST already hold the project lock; this function acquires NOTHING,
 * so it can run inside an outer locked region (e.g. `review approve`, which holds
 * the review lock across its whole mutation) WITHOUT a nested-acquire deadlock.
 *
 * Self-recovery: BEFORE opening the new batch it runs {@link replayJournal}, so a
 * `pending` journal left dangling by a prior crash is reverted under the SAME
 * held lock before this batch begins. A non-page kind throws `not-implemented`; a
 * mid-batch failure leaves a `pending` journal for replay to revert to the full
 * pre-state.
 *
 * @param root - Absolute project root.
 * @param planned - The approved mutations to apply.
 * @param opts - Optional injectable write primitive (for fault injection).
 */
export async function applyApprovedMutationsLocked(
  root: string,
  planned: PlannedMutation[],
  opts: ApplyOptions = {},
): Promise<void> {
  const writeOne = opts.writeOne ?? atomicWrite;
  // Recover any dangling pending batch from a prior crash under the held lock.
  await replayJournal(root);
  const batch = await openBatch(root);
  await applyBatch(root, planned, batch, writeOne);
  await commitBatch(batch);
}

/**
 * Apply an approved plan to disk atomically, acquiring the project lock itself.
 * Acquires the PID-based project lock, delegates the journalled batch to
 * {@link applyApprovedMutationsLocked} (replay → open → apply → commit), then
 * releases the lock in `finally`. There is ONE batch implementation; this is the
 * self-locking entry point for callers that do NOT already hold the lock.
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
  const acquired = await acquireLock(root);
  if (!acquired) throw new Error("could not acquire project lock for mutation batch");
  try {
    await applyApprovedMutationsLocked(root, planned, opts);
  } finally {
    await releaseLock(root);
  }
}
