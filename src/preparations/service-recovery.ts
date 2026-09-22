/**
 * @file src/preparations/service-recovery.ts
 * @description The `recovery` operation — diagnose one project's outstanding
 * lifecycle maintenance and park one STRANDED run so it stops being a
 * running-with-owner zombie (design v10 §5 row 9).
 *
 * IT ACQUIRES AT `recovery` INTENT, which is the one intent the mutation gate
 * lets straight through. That is deliberate and it is the whole point: every
 * other intent refuses while lifecycle maintenance is unfinished or a bundle
 * needs recovery, and recovery has to REACH those states to diagnose them. A
 * recovery operation that could be blocked by the condition it exists to
 * examine would be the guard-that-strands class in its purest form.
 *
 * STRANDED IS NOT BUSY, and the distinction is the load-bearing precondition.
 * `parkAttemptForRecoveryLocked` clears the execution owner, which is the fence
 * a live executor's results are validated against; parking a run whose executor
 * is still running would strip that fence out from under live work and convert a
 * transient wait into damage. So liveness is tested through `ownerProcessIsLive`
 * rather than through owner PRESENCE, and a live owner is refused rather than
 * parked. The same lesson was learned once already in the cancellation
 * settlement, where a blocked run with a live owner turned out not to be
 * stranded at all.
 *
 * EXACTLY WHAT THAT LIVENESS COVERS, because this refusal is the only thing
 * standing between a running executor and a cleared fence, and an earlier
 * revision of this header overstated it as simply "hardened, PID-reuse-safe":
 *
 *  - PID REUSE — covered. A recycled PID names a process whose start time
 *    differs from the recorded one, and that reads as stale.
 *  - SIGNAL PERMISSION — covered, and it was NOT until this was measured. A
 *    process this uid may not signal is alive; reading the denied probe as death
 *    parked a live foreign-uid executor.
 *  - PID NAMESPACES — NOT covered, and nothing here should be read as covering
 *    it. A container and its host number processes independently, so an owner
 *    recorded on one side and observed from the other is answered about the
 *    wrong process. `PreparationExecutionOwnerV1` carries no host identity to
 *    tell those apart; see the design gap recorded on that type.
 *
 * THE NAMESPACE PREMISE, RE-DERIVED FOR THE WIDENED PARK RATHER THAN INHERITED.
 * `run-types.ts` leaves the host/namespace identity unbuilt on the stated ground
 * that no shipped surface crosses a namespace boundary. That is a REACHABILITY
 * claim, so widening the park obliges this slice to re-establish it rather than
 * cite it. Re-derived, in three parts:
 *
 *  1. WHO may reclaim is unchanged. The park is reachable only through this
 *     operation — one CLI verb, one SDK method, one service — and this slice
 *     adds no second caller.
 *  2. FROM WHERE is unchanged. The observation is the same in-process
 *     `ownerProcessIsLive` on the same host, under the same project lock. No
 *     remote or cross-host probe is introduced.
 *  3. WHICH OWNERS EXIST is unchanged. `pause` does not mint an execution owner
 *     — it transitions a run that already carries one, written by the same
 *     attempt executor as before. The set of recordable owners does not grow;
 *     only the set of STATES one may be observed in does.
 *
 * So what widens is WHICH STATES this verb may park, not who may reclaim, from
 * where, or whose owner. The premise holds, and the unobservable case is
 * unchanged in kind: a live owner in a foreign namespace reports ESRCH exactly
 * as a corpse does, and no field on the record can separate them. That case is
 * NOT witnessed by any test here and must not be read as guarded — see the
 * probe table in the recovery park suite, which records it as unconstructible
 * rather than passing.
 *
 * THE PARK TARGET IS DERIVED, NEVER ACCEPTED. `attemptId` and `leaseNonce` are
 * lease fencing handles and appear in no request and no result; they are read
 * off the run's OWN durable execution owner, and the phase is the one whose
 * summary records that same attempt. The substrate then re-checks the pair
 * through `ownerFencesAttempt` — check and executor reading one authority rather
 * than two — so a caller has no channel through which to retarget the park.
 */

import { acquireMutationLock } from "../operation-bundles/lock-gate.js";
// The same pairing the gate documents: the gate acquires, utils releases.
import { releaseLock } from "../utils/lock.js";
import { ownerProcessIsLive } from "./attempts/lease.js";
import type { PhaseInstanceId } from "./ids.js";
import { preparationRunActor } from "./principals.js";
import type { PreparationPrincipal } from "./principals.js";
import {
  PARKABLE_RUN_STATES, parkAttemptForRecoveryLocked, resolvePreparationLifecyclePending,
} from "./recovery.js";
import type { PreparationLifecyclePendingState } from "./recovery.js";
import type { PreparationExecutionOwnerV1, PreparationRunV1 } from "./run-types.js";
import { REQUEST_CAPTURE_REFUSAL, capturedRequest } from "./service-request-capture.js";
import { resolveHostReadiness } from "./service-readiness.js";
import { resolvePreparationRun } from "./service-run-lookup.js";

/** Request for the `recovery` operation. Carries no actor, surface or grant. */
export interface RecoveryRequestV1 {
  /** The run to diagnose and, when it is stranded, park. */
  readonly runId: string;
}

/**
 * The project's outstanding lifecycle maintenance as this call observed it, or
 * `null` when the call refused BEFORE it could observe any.
 *
 * `null` is a third answer and not a fourth flavour of unavailable: `unavailable`
 * means the observation was attempted and could not be trusted, `null` means it
 * was never attempted. Collapsing them would report a project as unreadable on
 * the strength of a busy lock.
 */
export type RecoveryLifecycleV1 = PreparationLifecyclePendingState | null;

/** The closed outcome of one recovery attempt. */
export type RecoveryResultV1 =
  | {
    readonly status: "parked";
    readonly runId: string;
    readonly lifecycle: PreparationLifecyclePendingState;
  }
  | {
    /** The run was ALREADY at the state this operation drives to. */
    readonly status: "already-parked";
    readonly runId: string;
    readonly lifecycle: PreparationLifecyclePendingState;
  }
  | { readonly status: "refused"; readonly reason: string; readonly lifecycle: RecoveryLifecycleV1 };

/** The derived park target, or why this run has none. */
type ParkTarget =
  | { readonly ok: false; readonly reason: string }
  | {
    readonly ok: true;
    readonly owner: PreparationExecutionOwnerV1;
    readonly phaseInstanceId: PhaseInstanceId;
  };

/**
 * Derive the exact attempt this run's park would fence against, or refuse.
 *
 * Every leg is a distinct answer rather than one collapsed "cannot park": an
 * operator told "not stranded — a live executor holds it" waits, and an operator
 * told "no phase records this attempt" has a different problem entirely.
 */
function parkTarget(run: PreparationRunV1): ParkTarget {
  // THE SET IS DERIVED, and widening it is this slice's whole reason for
  // touching recovery. `running` alone left a `paused` run whose owner died with
  // NO exit by any shipped verb: the advisory custody leg subtracts owner-active
  // states, no attempt can start there, the settlement does not select it, and
  // `fail` is `planned`-only. Its edge to `recovery-required` was legal all
  // along and nothing could traverse it.
  if (!PARKABLE_RUN_STATES.has(run.state)) {
    return {
      ok: false,
      reason: `only a run holding an execution owner can be parked for recovery; this run is ${run.state}`,
    };
  }
  const owner = run.executionOwner;
  if (owner === undefined) {
    return { ok: false, reason: "this run records no execution owner, so there is no attempt to park" };
  }
  // LIVENESS, NOT PRESENCE. A recorded owner whose process is still running is a
  // BUSY run, not a stranded one, and clearing its fence would be damage.
  if (ownerProcessIsLive(owner)) {
    return {
      ok: false,
      reason: `this run is held by a live executor (pid ${owner.pid}); it is not stranded, so it is left alone`,
    };
  }
  const phase = run.phaseSummaries.find((summary) => summary.currentAttemptId === owner.attemptId);
  return phase === undefined
    ? { ok: false, reason: "no phase summary records the owner's attempt, so the park has no phase to mark" }
    : { ok: true, owner, phaseInstanceId: phase.phaseInstanceId };
}

/** Diagnose and, when the run is stranded, park it. The caller holds the lock. */
async function recoverLocked(
  root: string, runId: string, principal: PreparationPrincipal,
): Promise<RecoveryResultV1> {
  const lifecycle = await resolvePreparationLifecyclePending(root);
  const resolved = await resolvePreparationRun(root, runId);
  if (!resolved.ok) return { status: "refused", reason: resolved.reason, lifecycle };
  // ALREADY THERE IS NOT A FAILURE. `recovery-required` is the state this
  // operation drives to, so a second call reports the same outcome honestly
  // rather than refusing an idempotent retry.
  if (resolved.run.state === "recovery-required") return { status: "already-parked", runId, lifecycle };
  const target = parkTarget(resolved.run);
  if (!target.ok) return { status: "refused", reason: target.reason, lifecycle };
  await parkAttemptForRecoveryLocked({
    root, binding: resolved.binding, run: resolved.run, phaseInstanceId: target.phaseInstanceId,
    attemptId: target.owner.attemptId, leaseNonce: target.owner.leaseNonce,
    principal: preparationRunActor(principal), at: new Date().toISOString(),
  });
  return { status: "parked", runId, lifecycle };
}

/**
 * Park one stranded run and report the project's lifecycle maintenance state.
 *
 * `principal` is already captured and already charged its `preparation.recovery`
 * grant by the service composition.
 *
 * @param root - The project root this invocation acts within.
 * @param principal - The captured host principal the park transition credits.
 * @param request - The run the caller named.
 * @returns The park outcome and what this call observed of lifecycle state.
 */
export async function recoverPreparationOperation(
  root: string, principal: PreparationPrincipal, request: RecoveryRequestV1,
): Promise<RecoveryResultV1> {
  // CAPTURED IN THE SYNCHRONOUS PROLOGUE (D-10-9), read once and threaded to
  // both the action and the result, so no later reassignment can retarget the
  // durable park or make the result name a run this call never touched.
  //
  // BY DESCRIPTOR, because the prologue read was still a plain `[[Get]]` and an
  // own accessor therefore chose which run this call would park.
  const captured = capturedRequest<RecoveryRequestV1>(request);
  if (captured === null) {
    return { status: "refused", reason: REQUEST_CAPTURE_REFUSAL, lifecycle: null };
  }
  const runId = captured.runId;
  // READINESS FIRST. Unlike `cancel`, this operation reads and WRITES durable
  // key-bound run state, so a project whose own configuration cannot be read is
  // not a project it can act in.
  const ready = await resolveHostReadiness(root);
  if (!ready.ready) {
    return { status: "refused", reason: ready.reason ?? "the project is not ready", lifecycle: null };
  }
  const acquired = await acquireMutationLock(root, "recovery");
  // A REFUSAL, not a throw: a busy lock means nothing happened, which is exactly
  // what the declared `refused` arm is for.
  if (!acquired) return { status: "refused", reason: "project lock is busy", lifecycle: null };
  try {
    return await recoverLocked(root, runId, principal);
  } finally {
    await releaseLock(root);
  }
}
