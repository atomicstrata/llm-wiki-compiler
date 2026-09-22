/**
 * @file src/preparations/service-control-transition.ts
 * @description The two moves every OPERATOR CONTROL VERB makes identically:
 * resolve the run it was aimed at, and append one transition under the project
 * lock.
 *
 * EXTRACTED WITH BOTH CALLERS IN HAND, not ahead of them. `fail` and `pause`
 * differ entirely in their preconditions — one drives a planned run terminal, the
 * other holds a checkpointed run — and in nothing else: the same readiness gate,
 * the same run lookup, the same `ordinary` acquisition, the same append, the same
 * release, and the same choice to report a busy lock as a refusal rather than
 * throw. Two copies of that is how one comes to acquire at a different intent, or
 * to release on one path and not another.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN IS THE RUN ID. D-10-9 requires each
 * operation to capture `request.runId` in its OWN synchronous prologue, before
 * any await, because a field re-read after one retargets the durable transition
 * at a run the caller never named. Taking an already-captured `string` here keeps
 * that capture where the rule puts it — a helper that took the request would move
 * the read past the operation's first await and quietly undo the fix.
 */

import { RecoveryGateError, acquireMutationLock } from "../operation-bundles/lock-gate.js";
// The same pairing `operation drive` uses: the gate acquires, utils releases.
import { releaseLock } from "../utils/lock.js";
import { preparationRunPredecessor } from "./run-integrity.js";
import { appendPreparationTransitionLocked } from "./run-store.js";
import type {
  AppendPreparationTransitionInput, PreparationRunBinding, PreparationRunV1,
} from "./run-types.js";
import { resolveHostReadiness } from "./service-readiness.js";
import { resolvePreparationRun } from "./service-run-lookup.js";

/** The run a control verb will act on, or the reason it will not. */
type ControlTargetV1 =
  | { readonly ok: true; readonly binding: PreparationRunBinding; readonly run: PreparationRunV1 }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve the run one control verb was aimed at: the project is readable, and
 * the named run exists and loads.
 *
 * READINESS FIRST, and it is not an authority check. A project whose own
 * configuration cannot be read must not have a durable transition driven against
 * it; nothing here decides whether the caller MAY act, only whether acting is
 * meaningful.
 *
 * @param root - The project root this invocation acts within.
 * @param runId - The run id the operation captured in its synchronous prologue.
 * @returns The bound run, or the refusal reason to report unchanged.
 */
async function resolveControlTarget(root: string, runId: string): Promise<ControlTargetV1> {
  const ready = await resolveHostReadiness(root);
  if (!ready.ready) return { ok: false, reason: ready.reason ?? "the project is not ready" };
  const resolved = await resolvePreparationRun(root, runId);
  return resolved.ok
    ? { ok: true, binding: resolved.binding, run: resolved.run }
    : { ok: false, reason: resolved.reason };
}

/** Resolve a captured identity, preserving the refusal before invoking a control's own policy. */
export async function withControlTarget<T>(
  root: string, runId: string,
  apply: (binding: PreparationRunBinding, run: PreparationRunV1) => Promise<T>,
): Promise<T | { status: "refused"; reason: string }> {
  const target = await resolveControlTarget(root, runId);
  if (!target.ok) return { status: "refused", reason: target.reason };
  return apply(target.binding, target.run);
}

/**
 * The one wording for an acquisition that lost the race for the project lock.
 *
 * MODULE-PRIVATE: the three control verbs now receive this as a `reason` on the
 * returned refusal rather than composing it themselves, so exporting it would
 * put a second way to say one thing on the surface.
 */
const BUSY_LOCK_REFUSAL = "project lock is busy";

/** Whether one control transition landed, or the reason it did not. */
export type ControlAppendV1 =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Append one control transition under the project lock.
 *
 * AN `ordinary` INTENT: a control verb appends to one run's history and touches
 * no lifecycle registry, so it must not acquire as though it were destructive.
 *
 * BOTH WAYS THE ACQUISITION CAN DECLINE ARE RETURNED, and the second one was
 * missing while this docblock argued for the first. A busy lock was already a
 * refusal rather than a throw, on the stated ground that "throwing it left
 * `--json` with empty stdout so a consumer got no envelope at all" — and the
 * gate's own refusal, raised from the same call, still threw. That reasoning was
 * applied to one arm of one function and not the other.
 *
 * IT WAS UNREACHABLE UNTIL THE RESET SURFACE SHIPPED, which is why it survived:
 * `acquireMutationLock` is a GATED acquisition, and at `ordinary` it refuses
 * while any lifecycle unit is pending. Nothing that shipped could leave a
 * pending `project-key-reset` unit, so the operator never met this arm. Reset's
 * pass one is now the documented first step of a repair runbook, and it leaves
 * exactly that state — so `fail`, `pause` and `resume` were measured returning
 * exit 1 with an empty `--json` body in the state an operator reaches while
 * repairing their project.
 *
 * The RETURN TYPE changed rather than the message being widened, because a
 * boolean cannot carry the gate's reason, and reporting the gate's refusal as
 * "project lock is busy" would tell an operator to retry something that will
 * refuse identically forever.
 *
 * @param root - The project root this invocation acts within.
 * @param binding - The run's authenticated binding.
 * @param run - The run as read, supplying the predecessor the append is fenced to.
 * @param transition - The already-built transition, including its actor and instant.
 * @returns That the transition landed, or the honest reason it did not.
 */
export async function appendControlTransitionLocked(
  root: string, binding: PreparationRunBinding, run: PreparationRunV1,
  transition: AppendPreparationTransitionInput,
): Promise<ControlAppendV1> {
  let acquired: boolean;
  try {
    acquired = await acquireMutationLock(root, "ordinary");
  } catch (error) {
    // THE GATE'S OWN CLASS. `RecoveryGateError` is the base, so this covers every
    // arm the gate has and any it grows — the same classification `prune` and
    // `sweep` already perform at their own acquisition.
    if (error instanceof RecoveryGateError) return { ok: false, reason: error.message };
    throw error;
  }
  if (!acquired) return { ok: false, reason: BUSY_LOCK_REFUSAL };
  try {
    await appendPreparationTransitionLocked(root, binding, preparationRunPredecessor(run), transition);
    return { ok: true };
  } finally {
    await releaseLock(root);
  }
}
