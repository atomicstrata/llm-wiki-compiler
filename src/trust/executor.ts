/**
 * @file src/trust/executor.ts
 * @description The guarded MUTATION DISPATCHER — turns an approved
 * {@link PlannedMutation} plan into bytes on disk, under the CLP atomicity
 * contract ("partial application of an approved batch is a bug").
 *
 * STATUS: ALL current public mutation surfaces — compile, import, refresh,
 * review-approve, `createRelation`, and `transitionLifecycle` — route through
 * THIS ONE executor seam ({@link applyApprovedMutationsLocked}). Each enters the
 * locked core (review-approve under its already-held review lock; relation and
 * lifecycle under their own bounded-blocking acquire) so there is a single
 * under-lock authority and audit path, not a bespoke per-surface helper.
 *
 * This is NOT a cross-store all-or-none / co-commit guarantee. "One seam" means a
 * single dispatch + authority + journal discipline, NOT that a page/relation
 * mutation and its audit-event append land atomically together across their two
 * stores (see the cross-store audit residual documented in `relation-apply.ts`
 * and `lifecycle-apply.ts`). Cross-store co-commit is a Phase-5 op-ID journal task.
 *
 * ATOMICITY SCOPE (honest boundary). The journal batch covers ONLY the page
 * byte-writes in the plan. It does NOT extend to a consumer's post-write tail —
 * e.g. `review approve`'s source-state persist, index/MOC/embeddings refresh, and
 * candidate deletion run under the same lock but OUTSIDE this batch, and are
 * best-effort + idempotent/re-derivable rather than journalled. "The approved
 * batch applies atomically" means the PAGE BYTES, not the whole approve
 * operation.
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
 * project root via {@link confineUnderRoot} before it is touched (in
 * {@link applyPageMutationLocked}).
 *
 * SHAPE GUARD + DISPATCH: a GLOBAL {@link replayJournal} runs first (under the
 * held lock), then {@link assertBatchShape} rejects any batch that cannot be
 * applied atomically under today's single-store durability — a mixed-kind batch
 * or a multi-mutation single-store batch — with a typed
 * {@link CrossStoreBatchUnsupportedError}. A homogeneous page batch rides the
 * journalled page path and yields one {@link ApplyResult} per mutation; a lone
 * `relation` shape routes to {@link applyRelationLocked} (the under-lock
 * authority — re-load profile, re-plan, append) and yields its persisted ref;
 * a lone `lifecycle-transition` shape routes to {@link applyLifecycleLocked}
 * (the under-lock authority — re-load profile, compose a decision over the final
 * frontmatter, write via the shared page-apply primitive).
 *
 * S5 — FULL-FLOOR RE-ASSERTION AT APPLY: the executor is where bytes hit disk,
 * so it does not trust that plan-time checks still hold. The per-page primitive
 * {@link applyPageMutationLocked} re-runs the mandatory floor before every write;
 * a non-allow decision throws and writes NOTHING — a hand-built mutation that
 * bypassed the planner cannot smuggle an oversized or malformed body past.
 */

import { acquireLock, releaseLock } from "../utils/lock.js";
import { atomicWrite } from "../utils/markdown.js";
import { openBatch, commitBatch, replayJournal, type JournalBatch } from "./journal.js";
import { type ApplyResult, CrossStoreBatchUnsupportedError } from "./apply-result.js";
import { applyPageMutationLocked, type WriteOne } from "./page-apply.js";
import { applyRelationLocked } from "./relation-apply.js";
import { applyLifecycleLocked } from "./lifecycle-apply.js";
import { applyArtifactLocked } from "../artifacts/apply.js";
import type { PlannedMutation, PagePlannedMutation } from "./planner.js";

export type { WriteOne } from "./page-apply.js";

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
 * Reject any batch that cannot be applied atomically under today's single-store
 * durability. An empty or all-`page` batch is fine (the journalled page path
 * batches pages atomically). A mixed-kind batch has no cross-store op-ID
 * atomicity (a Phase-5 task), and a multi-mutation single non-page store has no
 * per-store batch semantics yet — both throw a typed
 * {@link CrossStoreBatchUnsupportedError}. A lone relation/lifecycle shape
 * passes the guard and routes to its under-lock handler.
 *
 * BATCH-SHAPE GUARD = the safety net for deferred cross-store atomicity. Because
 * mixed-store and multi-non-page batches are REFUSED here, the executor never has
 * to span two stores in one batch — so the absence of a cross-store op-ID journal
 * cannot silently produce a torn cross-store batch. The only multi-mutation path
 * that survives the guard is the all-`page` batch, which IS journalled atomically
 * within its single store. This guard relaxes (admitting mixed/multi-store
 * batches) only when the Phase-5 op-ID journal lands to make them co-committable.
 */
function assertBatchShape(planned: PlannedMutation[]): void {
  if (planned.length === 0) return;
  const kinds = new Set(planned.map((m) => m.kind));
  if (planned.every((m) => m.kind === "page")) return;
  if (kinds.size > 1) {
    throw new CrossStoreBatchUnsupportedError(`mixed-kind batch: ${[...kinds].join("+")}`);
  }
  if (planned.length > 1) {
    throw new CrossStoreBatchUnsupportedError(`multi-${planned[0].kind} batch (no per-store batch semantics yet)`);
  }
}

/**
 * Apply every page mutation in the batch under an already-open journal, delegating
 * each to the shared per-page primitive {@link applyPageMutationLocked}. Throws on
 * the first collision, floor violation, or failing write, leaving the journal
 * uncommitted for replay.
 */
async function applyBatch(
  root: string,
  planned: PagePlannedMutation[],
  batch: JournalBatch,
  writeOne: WriteOne,
): Promise<void> {
  for (const mutation of planned) {
    await applyPageMutationLocked(root, mutation, batch, writeOne);
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
 * Self-recovery: BEFORE the shape guard it runs a GLOBAL {@link replayJournal}, so
 * a `pending` journal left dangling by a prior crash is reverted under the SAME
 * held lock before this batch begins. Then {@link assertBatchShape} rejects an
 * un-applicable batch shape; a homogeneous page batch is journalled and yields one
 * {@link ApplyResult} per mutation; a lone `relation` shape routes to
 * {@link applyRelationLocked} and yields its persisted ref; a lone
 * `lifecycle-transition` shape routes to {@link applyLifecycleLocked} and yields
 * a lifecycle ApplyResult; a lone `artifact` shape routes to
 * {@link applyArtifactLocked} and yields its persisted ref. A mid-batch page
 * failure leaves a `pending` journal for replay to revert to the full pre-state.
 *
 * @param root - Absolute project root.
 * @param planned - The approved mutations to apply.
 * @param opts - Optional injectable write primitive (for fault injection).
 * @returns One {@link ApplyResult} per applied mutation.
 */
export async function applyApprovedMutationsLocked(
  root: string,
  planned: PlannedMutation[],
  opts: ApplyOptions = {},
): Promise<ApplyResult[]> {
  // GLOBAL replay-before-dispatch, under the held lock: recover any dangling
  // pending batch from a prior crash before any shape decision or new write.
  await replayJournal(root);
  assertBatchShape(planned);
  if (planned.length === 0) return [];
  if (planned.every((m) => m.kind === "page")) {
    const writeOne = opts.writeOne ?? atomicWrite;
    const batch = await openBatch(root);
    await applyBatch(root, planned as PagePlannedMutation[], batch, writeOne);
    await commitBatch(batch);
    return planned.map(() => ({ kind: "page" as const }));
  }
  if (planned.length === 1 && planned[0].kind === "relation") {
    // The relation handler is the UNDER-LOCK authority: it re-loads the profile,
    // re-plans, re-composes the decision, and appends — the caller-supplied plan
    // is intent only. The persisted ref + composed decision flow back through the
    // apply RESULT, so a consumer records the REAL decision (not a literal).
    const { ref, decision } = await applyRelationLocked(root, planned[0]);
    return [{ kind: "relation", ref, decision }];
  }
  if (planned.length === 1 && planned[0].kind === "lifecycle-transition") {
    // The lifecycle handler is the UNDER-LOCK authority: it re-loads the profile,
    // composes a real decision over the FINAL frontmatter (FSM + entity fields),
    // and writes via the shared page-apply primitive — no dispatcher re-entry.
    // The composed decision flows back through the apply RESULT.
    const decision = await applyLifecycleLocked(root, planned[0]);
    return [{ kind: "lifecycle-transition", decision }];
  }
  if (planned.length === 1 && planned[0].kind === "artifact") {
    // The artifact handler is the UNDER-LOCK authority: it re-loads the profile,
    // re-plans (composing the real decision over the type-declared + body-contract
    // checks), gates on the operator trusted-write grant, and writes the content-
    // addressed bytes + manifest via the journal. The composed decision flows back
    // through the apply RESULT.
    const { ref, decision } = await applyArtifactLocked(root, planned[0]);
    return [{ kind: "artifact", ref, decision }];
  }
  // workflow kinds stay not-implemented.
  throw new NotImplementedMutationError(planned[0].kind);
}

/**
 * Apply an approved plan to disk atomically, acquiring the project lock itself.
 * Acquires the PID-based project lock, delegates the journalled batch to
 * {@link applyApprovedMutationsLocked} (replay → guard → open → apply → commit),
 * then releases the lock in `finally`. There is ONE batch implementation; this is
 * the self-locking entry point for callers that do NOT already hold the lock.
 *
 * @param root - Absolute project root.
 * @param planned - The approved mutations to apply.
 * @param opts - Optional injectable write primitive (for fault injection).
 * @returns One {@link ApplyResult} per applied mutation.
 */
export async function applyApprovedMutations(
  root: string,
  planned: PlannedMutation[],
  opts: ApplyOptions = {},
): Promise<ApplyResult[]> {
  const acquired = await acquireLock(root);
  if (!acquired) throw new Error("could not acquire project lock for mutation batch");
  try {
    return await applyApprovedMutationsLocked(root, planned, opts);
  } finally {
    await releaseLock(root);
  }
}
