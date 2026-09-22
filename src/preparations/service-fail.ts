/**
 * @file src/preparations/service-fail.ts
 * @description The `fail` operation — drive one run to the terminal `failed`
 * state. R-3 made it official: `planned -> failed` is the only terminal
 * transition the substrate can actually reach, and the twelve-operation table
 * carries no terminal verb at all.
 *
 * An audit of `main` found six of eight terminal states have no production
 * writer, and `handed-off` — which has one — is unreachable because nothing
 * writes its required predecessor `handoff-ready`. Every test that reaches those
 * states drives the appender through a `type as never` cast, i.e. produces
 * transitions production cannot.
 *
 * `planned -> failed` carries no extra precondition: `failed` is not a success
 * state, and the state-coupling assertions are vacuous for a run with no
 * handoff, no owner, no effects and no residual findings. So it is one appender
 * call, and it completes a real lifecycle without inventing a completeness
 * authority or a leg runner to do it.
 */

import { preparationRunActor } from "./principals.js";
import type { PreparationPrincipal } from "./principals.js";
import type { PreparationRunBinding, PreparationRunV1 } from "./run-types.js";
import { LEGAL_EDGES } from "./run-validation.js";
import { appendControlTransitionLocked, withControlTarget } from "./service-control-transition.js";
import type { ControlAppendV1 } from "./service-control-transition.js";
import { REQUEST_CAPTURE_REFUSAL, capturedRequest } from "./service-request-capture.js";

/** Request for the `fail` operation. Carries no actor, surface or grant. */
export interface FailRequestV1 {
  /** The run to drive terminal. */
  readonly runId: string;
}

/** The closed outcome of one fail attempt. */
export type FailResultV1 =
  | { readonly status: "failed"; readonly runId: string }
  | { readonly status: "refused"; readonly reason: string };

/** Name the right remedy for a state `fail` will not touch. */
function wrongStateReason(state: PreparationRunV1["state"]): string {
  return state === "recovery-required"
    ? "a recovery-required run must be abandoned with an explicit residual-state confirmation, not failed"
    : `only a planned run can be failed directly; this run is ${state}`;
}

/**
 * Whether this run may reach `failed`, and why not.
 *
 * DERIVED from `LEGAL_EDGES`, never restated: eleven of sixteen states cannot
 * reach `failed`, and without this check each one escaped as a raw validator
 * string — "illegal preparation run state edge" — past the `refused` arm built
 * for exactly that. Nothing was corrupted, because validation runs before the
 * write, but a caller got an internal message instead of an answer.
 *
 * THERE IS DELIBERATELY NO OWNER RULE HERE, and an earlier revision carried one
 * that could never fire. `planned` is not in `OWNER_ACTIVE_STATES`, so the run
 * store's own coupling assertion refuses to LOAD a `planned` run carrying an
 * execution owner — a run reaching the line below has no owner by construction.
 * The dead branch was worse than redundant once `recover` shipped: it told the
 * operator to "recover it before failing", naming a verb that drives the run to
 * `recovery-required`, which is a state this operation explicitly refuses.
 */
function failRefusal(run: PreparationRunV1): string | null {
  // Terminal is DERIVED — a state with no outgoing edges — rather than read
  // from a fourth hand-written copy of the set.
  if (LEGAL_EDGES[run.state].size === 0) {
    return `this run is already terminal (${run.state}); nothing to fail`;
  }
  // BOUND TO `planned`, NOT to what the edge table permits. Deriving the
  // precondition from `LEGAL_EDGES` alone made this a back door around
  // `abandonment.ts`: that module exists so a run may leave `recovery-required`
  // terminally ONLY under an explicit residual-state confirmation, with
  // findings RECOMPUTED from the run's own durable state so a caller cannot
  // understate what remained unresolved. `failed` carries a `none` payload —
  // the schema has nowhere to put findings — and costs `preparation.run`
  // rather than the abandonment grant, so reaching a terminal that way skips
  // every one of those controls.
  //
  // A legal edge is a record-shape constraint, not an authority statement.
  return run.state !== "planned" ? wrongStateReason(run.state) : null;
}

/** Append the terminal transition through the shared control-verb primitive. */
async function appendFailed(
  root: string, binding: PreparationRunBinding, run: PreparationRunV1,
  principal: PreparationPrincipal,
): Promise<ControlAppendV1> {
  return appendControlTransitionLocked(root, binding, run, {
    type: "failed", stateAfter: "failed",
    payload: { kind: "none" },
    actor: preparationRunActor(principal), at: new Date().toISOString(),
  });
}

/** Apply the state precondition, then append. */
async function failResolved(
  root: string, runId: string, binding: PreparationRunBinding, run: PreparationRunV1,
  principal: PreparationPrincipal,
): Promise<FailResultV1> {
  const refused = failRefusal(run);
  if (refused !== null) return { status: "refused", reason: refused };
  // THE ACQUISITION'S OWN REASON, carried through rather than collapsed. This
  // read `project lock is busy` for every decline, including the recovery
  // gate's — which told an operator to retry something that would refuse
  // identically forever.
  const appended = await appendFailed(root, binding, run, principal);
  return appended.ok ? { status: "failed", runId } : { status: "refused", reason: appended.reason };
}

/**
 * Drive one run terminal, or say why not.
 *
 * `principal` is already captured and already charged its `preparation.run`
 * grant by the service composition.
 */
export async function failPreparationOperation(
  root: string, principal: PreparationPrincipal, request: FailRequestV1,
): Promise<FailResultV1> {
  // CAPTURED IN THE SYNCHRONOUS PROLOGUE (D-10-9), exactly as `stage` captures
  // its request. This operation read `request.runId` twice, both times after
  // awaiting readiness, and both reads were live:
  //
  //  - reassigning the field after the call returned retargeted the durable
  //    transition — the service terminated a run the caller never named while
  //    the one it did name stayed planned;
  //  - and because the two reads were separate, a field answering differently
  //    each time drove ONE run terminal and named ANOTHER in the result, so the
  //    response described a run the service never touched.
  //
  // One read, one value, threaded to both legs. The sibling operation had this
  // fix and this one did not inherit it; today's two surfaces both pass fresh
  // literals, which is the same "not reachable" argument this service rejected
  // when the stage capture was moved out of the facade and down to here.
  //
  // AND THE READ ITSELF IS BY DESCRIPTOR. Reading `request.runId` was a plain
  // `[[Get]]`, so an own accessor executed and this operation drove a run
  // TERMINAL on the value it returned. Timing was never the only question.
  //
  // THE GUARD STAYS AHEAD OF THE FIRST AWAIT. `resolveControlTarget` is that
  // await — it folds the readiness check and the run lookup this operation used
  // to do inline, in the same order and with the same refusals. Capturing after
  // it would leave the caller's object readable across a boundary again, which
  // is the whole property the capture exists for.
  const captured = capturedRequest<FailRequestV1>(request);
  if (captured === null) return { status: "refused", reason: REQUEST_CAPTURE_REFUSAL };
  const runId = captured.runId;
  return withControlTarget(root, runId, (binding, run) => failResolved(root, runId, binding, run, principal));
}
