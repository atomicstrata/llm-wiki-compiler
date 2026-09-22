/**
 * @file src/preparations/service-pause.ts
 * @description The `pause` operation — hold one run at a durable safe checkpoint
 * so an operator can stop it advancing without cancelling it.
 *
 * `paused` HAD NO PRODUCTION WRITER BEFORE THIS. The state, its transition type
 * and its edges have been in the tables since the substrate landed; nothing ever
 * appended one, so every test that reached `paused` produced a transition
 * production could not. This is that writer, and being the first one is why the
 * preconditions below are stated against the design's own definition of the state
 * rather than against what the edge table merely permits.
 *
 * IT REFUSES WHILE AN ATTEMPT IS IN FLIGHT, and that is the definition rather
 * than caution: design section 9's state table defines `paused` as "all active
 * attempts reached durable safe checkpoints". The execution owner IS that
 * question — it is written when a phase attempt starts and cleared when the
 * attempt settles or parks, so a run carrying one has an attempt between those
 * points and has reached no checkpoint. Appending `paused` there would claim a
 * property the run does not have, and would leave a live leg committing into a
 * state its own commit precondition refuses.
 *
 * THE REFUSAL NAMES A DIFFERENT REMEDY PER LIVENESS CLASS, AND THE CLASS DECIDES
 * NOTHING. Whether the owner's process is alive changes only which exit to point
 * at — wait for the phase, or recover the run. It never changes whether the
 * refusal happens, so no destructive move here is made more permissive by a
 * liveness observation that failed.
 *
 * IT SHIPS WITH ITS RESUME, in this commit, and the argument for shipping without
 * one is recorded here because it was wrong in an instructive way. That argument
 * ran: `paused -> running` is not the sole exit, since `recovery-required`,
 * `cancelling` and `failed` are all reachable from `paused` by verbs that already
 * ship — so a paused run always has a way out. Every clause of it is true, and
 * the conclusion does not follow. **Reachability was traced; authority was not.**
 * `cancel` costs `preparation.cancel`, `recovery` costs `preparation.recovery`,
 * and the remaining routes cost the destructive `preparation.quarantine`, while
 * this operation costs `preparation.run`. An SDK principal holding only the token
 * that lets it pause could therefore pause a run and never release it.
 *
 * A GUARANTEE BOUNDED BY A GRANT IS NOT A GUARANTEE. The exit now costs exactly
 * what the entrance costs — see {@link file://./service-resume.ts} — and the
 * property is stated as *escapable by a principal holding `preparation.run`*
 * rather than as a count of commands, because a count hides the authority.
 */

import { REQUEST_CAPTURE_REFUSAL, capturedRequest } from "./service-request-capture.js";
import { classifyExecutionOwnerLiveness } from "./attempts/lease.js";
import { preparationRunActor } from "./principals.js";
import type { PreparationPrincipal } from "./principals.js";
import type {
  PreparationExecutionOwnerV1, PreparationRunBinding, PreparationRunState, PreparationRunV1,
} from "./run-types.js";
import { LEGAL_EDGES } from "./run-validation.js";
import { appendControlTransitionLocked, withControlTarget } from "./service-control-transition.js";
import type { ControlAppendV1 } from "./service-control-transition.js";

/** Request for the `pause` operation. Carries no actor, surface or grant. */
export interface PauseRequestV1 {
  /** The run to hold at its current checkpoint. */
  readonly runId: string;
}

/** The closed outcome of one pause attempt. */
export type PauseResultV1 =
  | {
    readonly status: "paused";
    readonly runId: string;
    /** Whether this call appended the transition or found the run already held. */
    readonly transition: "appended" | "already-paused";
  }
  | { readonly status: "refused"; readonly reason: string };

/**
 * The one state a run may be paused FROM.
 *
 * A SINGLETON BY DEFINITION RATHER THAN BY DERIVATION, and this is the mirror of
 * the argument {@link file://./service-resume.ts} already makes for its own
 * domain. Deriving it from the edge table looks right — "may be paused" reads
 * exactly like "has an edge to `paused`" — and it admitted `awaiting-gate`,
 * because that state legally reaches `paused`.
 *
 * WHICH MADE THE PAIR A WAY PAST A GATE. Neither transition is illegal alone:
 * `awaiting-gate -> paused` and `paused -> running` are both in the table. Their
 * COMPOSITION is the edge the table does not have — `awaiting-gate -> running` —
 * and nothing recorded the origin, because pause's transition carries
 * `{ kind: "none" }` and resume always restores `running`. Reproduced through
 * the SDK by an embedder holding only `preparation.run`, with no gate decision
 * recorded anywhere.
 *
 * THE REASONING EXISTED AND WAS APPLIED TO ONE END OF THE PAIR. Resume's domain
 * is a singleton precisely because deriving it "would make this verb a way to
 * push a run past a gate it is waiting on" — written four lines away, in the
 * same commit, while this end derived from that same table. The question that
 * was not asked is the one that always applies: *what is the sibling of what I
 * just hardened?*
 *
 * PAUSING A GATE WAIT IS NOT A REQUIREMENT, so nothing is added to make it safe.
 * A run waiting on a decision is already not advancing; there is nothing for a
 * hold to hold. If it ever becomes one, it needs an origin the resume can
 * restore, and that is its own decision rather than a widening of this line.
 */
export const PAUSABLE_RUN_STATE = "running" as const satisfies PreparationRunState;

/**
 * Whether the substrate still admits the edge this operation depends on.
 *
 * CROSS-CHECKED AGAINST THE TABLE RATHER THAN COPIED FROM IT — the same
 * relationship resume has with its own edge. The table is consulted, so a table
 * change cannot silently widen this domain, and it cannot silently empty it
 * either: if `running -> paused` is ever withdrawn this reads false and a
 * control fails loudly, rather than leaving a shipped verb that refuses every
 * call while its docblock still promises a hold.
 */
export const PAUSE_EDGE_EXISTS: boolean = LEGAL_EDGES[PAUSABLE_RUN_STATE].has("paused");

/**
 * Name the exit for a run whose attempt is still recorded as in flight.
 *
 * All three classes refuse. They differ in what the operator should do next, and
 * the third is the one worth spelling out: when the owner cannot be identified at
 * all, `recover` will not park it either — it treats unidentifiable as live, by
 * the same fail-safe rule — so telling the operator to recover would send them at
 * a verb that is also going to refuse. Saying so is the difference between a
 * pause they can retry and a run they need to escalate.
 */
function inFlightRefusal(owner: PreparationExecutionOwnerV1): string {
  const liveness = classifyExecutionOwnerLiveness(owner);
  if (liveness === "live") {
    return "an attempt is still running on this run; pause holds a run at a durable checkpoint, so "
      + "wait for the phase to settle and pause then, or cancel the run to stop it now";
  }
  if (liveness === "stale") {
    return "the process that was running this run's attempt is gone, so the run is not at a checkpoint; "
      + "recover the run first, then pause it";
  }
  return "this run records an attempt in flight and this host cannot determine whether its process is "
    + "still alive, so neither pause nor recovery will act on it; the run needs an operator to confirm "
    + "the executor is gone";
}

/**
 * Whether this run may be paused, and why not.
 *
 * ORDER IS DELIBERATE. Terminality is reported before pausability because "this
 * run already finished" is a more useful answer than "a finished run cannot be
 * paused", and the in-flight check comes last because it is the only one whose
 * message tells the operator to come back — reporting it over a run that could
 * never be paused anyway would send them to wait for nothing.
 */
function pauseRefusal(run: PreparationRunV1): string | null {
  if (LEGAL_EDGES[run.state].size === 0) {
    return `this run is already terminal (${run.state}); there is nothing to pause`;
  }
  // AND THE GATE WAIT NAMES ITS OWN VERB, because "only a running run can be
  // paused" over a run waiting on a decision reads as an arbitrary restriction
  // rather than the reason it is one.
  if (run.state === "awaiting-gate") {
    return "this run is waiting on a gate decision, so it is not advancing and there is nothing to "
      + "hold; record the decision with the gate verb, which is what releases it";
  }
  if (run.state !== PAUSABLE_RUN_STATE) {
    return `only a running run can be paused; this run is ${run.state}`;
  }
  return run.executionOwner === undefined ? null : inFlightRefusal(run.executionOwner);
}

/** Append the pause transition through the shared control-verb primitive. */
async function appendPaused(
  root: string, binding: PreparationRunBinding, run: PreparationRunV1, principal: PreparationPrincipal,
): Promise<ControlAppendV1> {
  return appendControlTransitionLocked(root, binding, run, {
    type: "paused", stateAfter: "paused",
    payload: { kind: "none" },
    actor: preparationRunActor(principal), at: new Date().toISOString(),
  });
}

/** Apply the state preconditions, then append. */
async function pauseResolved(
  root: string, runId: string, binding: PreparationRunBinding, run: PreparationRunV1,
  principal: PreparationPrincipal,
): Promise<PauseResultV1> {
  // IDEMPOTENT BEFORE THE PRECONDITIONS, because `paused` has no self-edge: a
  // second pause of an already-held run would otherwise be reported as a state
  // refusal, which reads as "your pause did not take" for a run that is paused.
  if (run.state === "paused") return { status: "paused", runId, transition: "already-paused" };
  const refused = pauseRefusal(run);
  if (refused !== null) return { status: "refused", reason: refused };
  const appended = await appendPaused(root, binding, run, principal);
  return appended.ok
    ? { status: "paused", runId, transition: "appended" }
    : { status: "refused", reason: appended.reason };
}

/**
 * Hold one run at its checkpoint, or say why not.
 *
 * `principal` is already captured and already charged its `preparation.run`
 * grant by the service composition.
 *
 * @param root - The project root this invocation acts within.
 * @param principal - The captured host principal this transition is credited to.
 * @param request - The run the caller named.
 * @returns Whether the run was paused, already paused, or refused.
 */
export async function pausePreparationOperation(
  root: string, principal: PreparationPrincipal, request: PauseRequestV1,
): Promise<PauseResultV1> {
  // CAPTURED IN THE SYNCHRONOUS PROLOGUE (D-10-9), read once and threaded — a
  // field re-read after an await retargets the durable transition at a run the
  // caller never named.
  //
  // AND READ BY DESCRIPTOR. The timing half above was already right; the read
  // itself was a plain `[[Get]]`, so an own accessor executed in the prologue of
  // the FIRST PRODUCTION WRITER of `paused`. Answering WHEN says nothing about
  // HOW, and this operation was written before the capture existed — the
  // totality control caught it as the invariant's first new member.
  //
  // AHEAD OF THE FIRST AWAIT inside `withControlTarget` below.
  const captured = capturedRequest<PauseRequestV1>(request);
  if (captured === null) return { status: "refused", reason: REQUEST_CAPTURE_REFUSAL };
  const runId = captured.runId;
  return withControlTarget(root, runId, (binding, run) => pauseResolved(root, runId, binding, run, principal));
}
