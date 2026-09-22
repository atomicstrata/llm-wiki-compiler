/**
 * @file src/preparations/service-resume.ts
 * @description The `resume` operation — return one paused run to `running`, and
 * the reason `pause` is allowed to exist at all.
 *
 * THE GUARANTEE THIS FILE CARRIES: **a paused run is escapable by a principal
 * holding `preparation.run`** — the same token `pause` costs, and nothing more.
 * That sentence, not a count of commands, is the contract. `pause` shipped once
 * without it and was refused on review, and the refusal is worth restating
 * precisely because the original argument sounded adequate: the exits existed
 * (`recovery-required`, `cancelling`, `failed` are all reachable from `paused`),
 * and they were reachable in one or two shipped commands. What nobody asked was
 * WHICH GRANT those commands require. `cancel` costs `preparation.cancel`,
 * `recovery` costs `preparation.recovery`, and releasing a paused run any other
 * way costs the destructive `preparation.quarantine`. An SDK principal holding
 * only `preparation.run` could therefore pause a run and never get it back.
 *
 * A GUARANTEE BOUNDED BY A GRANT IS NOT A GUARANTEE, and the stranding principal
 * is always the LEAST-PRIVILEGED one who can enter the state. So the exit costs
 * exactly what the entrance costs, and the control that proves it holds only
 * `preparation.run` — a test run as a local operator would prove nothing, because
 * a `cli` principal holds the whole local-operator set by transport.
 *
 * IT IS NOT A CANCELLATION AND NOT A RECOVERY. Both of those are ways to stop
 * caring about a run; neither returns it to the state it was in. An exit that
 * ends the work is not an exit from a pause, which is why no destructive route
 * and no cancellation route counted.
 *
 * `running` IS THE STATE PAUSE TOOK IT FROM, not a claim of work in flight. This
 * is the objection an earlier attempt at `resume` genuinely earned — it landed
 * `running` with no leg runner, so the record advertised an attempt that did not
 * exist. It does not apply here, and the reason is `pause`'s own precondition:
 * pause REFUSES while an execution owner is recorded, so a paused run provably
 * has none, and `resumed` restores exactly the ownerless `running` the run was
 * held from. The record claims no attempt because no attempt field is written.
 */

import { REQUEST_CAPTURE_REFUSAL, capturedRequest } from "./service-request-capture.js";
import { preparationRunActor } from "./principals.js";
import type { PreparationPrincipal } from "./principals.js";
import type { PreparationRunBinding, PreparationRunState, PreparationRunV1 } from "./run-types.js";
import { LEGAL_EDGES } from "./run-validation.js";
import { appendControlTransitionLocked, withControlTarget } from "./service-control-transition.js";
import type { ControlAppendV1 } from "./service-control-transition.js";

/** Request for the `resume` operation. Carries no actor, surface or grant. */
export interface ResumeRequestV1 {
  /** The paused run to return to `running`. */
  readonly runId: string;
}

/** The closed outcome of one resume attempt. */
export type ResumeResultV1 =
  | {
    readonly status: "resumed";
    readonly runId: string;
    /** Whether this call appended the transition or found the run already running. */
    readonly transition: "appended" | "already-running";
  }
  | { readonly status: "refused"; readonly reason: string };

/** The state `resume` returns a run to — `resumed` targets exactly this one. */
const RESUME_TARGET_STATE = "running" as const satisfies PreparationRunState;

/**
 * The one state a run may be resumed FROM.
 *
 * A SINGLETON BY DEFINITION RATHER THAN BY DERIVATION, and the reason is the one
 * this pair learned the hard way. Deriving would admit every state carrying an
 * edge to `running` — `awaiting-gate` among them — which would make this verb a
 * way to push a run past a gate it is waiting on. Resume is the inverse of pause,
 * so its domain is the state pause writes.
 *
 * `pause` IS NOW A SINGLETON TOO, and this paragraph used to say the opposite:
 * that pause "derives its domain from the edge table because 'may be paused' IS
 * 'has an edge to `paused`'", offered as the contrast that made resume's
 * hand-written domain look exceptional. That contrast was the defect. Pause's
 * derivation admitted `awaiting-gate`, and since both legs were legal edges the
 * PAIR composed into `awaiting-gate -> running` — the exact bypass this very
 * paragraph warned about, live on the other end of it. Both domains are now
 * singletons, each cross-checked against the table rather than copied from it.
 *
 * CROSS-CHECKED AGAINST THE TABLE rather than merely written beside it — see
 * {@link RESUME_EDGE_EXISTS}. A hand-written set and a derived table that can
 * silently disagree is the recurring defect in this tree; here they cannot, because
 * the disagreement is asserted rather than assumed.
 */
export const RESUMABLE_RUN_STATE = "paused" as const satisfies PreparationRunState;

/**
 * Whether the substrate still admits the edge this operation depends on.
 *
 * Exported so a control asserts it instead of the operation trusting it. If the
 * edge table ever stops admitting `paused -> running`, this reads false and the
 * control fails loudly — rather than leaving a shipped verb that refuses every
 * call it is offered while its docblock still promises an exit.
 */
export const RESUME_EDGE_EXISTS: boolean =
  LEGAL_EDGES[RESUMABLE_RUN_STATE].has(RESUME_TARGET_STATE);

/**
 * Why this run cannot be resumed, in the operator's own terms.
 *
 * EACH REFUSAL NAMES THE VERB THAT DOES APPLY. A run that needs recovery is not
 * resumed here — the ratified contract routes it to the recovery operation, which
 * holds the authority to re-drive a stranded attempt — and saying only "this run
 * is recovery-required" leaves an operator to guess which of five verbs to reach
 * for next.
 */
function resumeRefusal(run: PreparationRunV1): string | null {
  if (run.state === RESUMABLE_RUN_STATE) return null;
  if (LEGAL_EDGES[run.state].size === 0) {
    return `this run is already terminal (${run.state}); there is nothing to resume`;
  }
  if (run.state === "recovery-required") {
    return "this run is parked for recovery rather than paused; recover it, which re-drives the "
      + "attempt that stranded — resume only lifts an operator's own pause";
  }
  return `only a paused run can be resumed; this run is ${run.state}`;
}

/** Append the resume transition through the shared control-verb primitive. */
async function appendResumed(
  root: string, binding: PreparationRunBinding, run: PreparationRunV1,
  principal: PreparationPrincipal,
): Promise<ControlAppendV1> {
  return appendControlTransitionLocked(root, binding, run, {
    type: "resumed", stateAfter: RESUME_TARGET_STATE,
    payload: { kind: "none" },
    actor: preparationRunActor(principal), at: new Date().toISOString(),
  });
}

/** Apply the state preconditions, then append. */
async function resumeResolved(
  root: string, runId: string, binding: PreparationRunBinding, run: PreparationRunV1,
  principal: PreparationPrincipal,
): Promise<ResumeResultV1> {
  // IDEMPOTENT BEFORE THE PRECONDITIONS, exactly as `pause` is. A retry after a
  // dropped connection must not report "only a paused run can be resumed" for a
  // run this operator already resumed — that reads as a failure of the retry.
  if (run.state === RESUME_TARGET_STATE) {
    return { status: "resumed", runId, transition: "already-running" };
  }
  const refused = resumeRefusal(run);
  if (refused !== null) return { status: "refused", reason: refused };
  const appended = await appendResumed(root, binding, run, principal);
  return appended.ok
    ? { status: "resumed", runId, transition: "appended" }
    : { status: "refused", reason: appended.reason };
}

/**
 * Return one paused run to `running`, or say why not.
 *
 * `principal` is already captured and already charged its `preparation.run`
 * grant by the service composition — the same token `pause` charges, which is
 * what makes the exit reachable by every principal that can enter the state.
 *
 * @param root - The project root this invocation acts within.
 * @param principal - The captured host principal this transition is credited to.
 * @param request - The run the caller named.
 * @returns Whether the run was resumed, already running, or refused.
 */
export async function resumePreparationOperation(
  root: string, principal: PreparationPrincipal, request: ResumeRequestV1,
): Promise<ResumeResultV1> {
  // CAPTURED IN THE SYNCHRONOUS PROLOGUE AND BY DESCRIPTOR (D-10-9), for the same
  // reason `pause` is: this is a write path, and an own accessor here would
  // retarget the durable transition at a run the caller never named.
  const captured = capturedRequest<ResumeRequestV1>(request);
  if (captured === null) return { status: "refused", reason: REQUEST_CAPTURE_REFUSAL };
  const runId = captured.runId;
  return withControlTarget(root, runId, (binding, run) => resumeResolved(root, runId, binding, run, principal));
}
