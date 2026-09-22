/**
 * @file src/preparations/service-gate.ts
 * @description The `gate` operation — RECORD one host-authored gate decision and
 * PERFORM NOTHING ELSE (design v10 §5 row 5).
 *
 * ALL EIGHT GATE KINDS RECORD AUTHORITY AND PERFORM NOTHING, including the five
 * whose approval other protocols consume. An earlier revision of the operation
 * table had this operation STARTING the effect protocol — before its own approval
 * was recorded, and without the attempt, lease, effect plan, broker call or
 * receipt that protocol needs. The recorded authority is consumed LATER, by the
 * operation that owns the work: an external effect requires a current approved
 * `confirm-external-effect` proof at `effects.ts`, and abandonment consumes its
 * own proof in the operation that abandons. Recording is this operation's whole
 * job, and it is why the run's state is unchanged by it.
 *
 * PERSISTENCE IS THE PART THAT IS EASY TO GET WRONG, and it was got wrong: the
 * plain transition writer records the transition and NEVER populates
 * `run.gateProofs`. A flow that authored the proof and appended only the
 * transition would leave `findApprovedGateProof` looking for an approval that was
 * computed and then dropped — a gate that reported success and authorized nothing.
 * So the write goes through `appendProjectedTransitionLocked` with a projector
 * that appends the COMPLETE `GateProofSummaryV1`, which is the same
 * transition-plus-projection writer effects already uses. The summary carries
 * every dimension the fact binds — plan, phase, input, effect, authority — so the
 * durable-summary revalidation downstream is served by the record, not by a
 * second store this operation would otherwise have to invent.
 *
 * THE DECISION INDEX IS DERIVED, NEVER ACCEPTED. `gateProofId` is derived from
 * the run, gate, plan digest and index, and the run loader rejects a duplicate
 * proof id outright. A caller-supplied index would therefore let one caller make
 * a later decision unrecordable, or collide with a decision already made. It is
 * the count of this gate's own recorded decisions instead — monotonic per gate,
 * and computed from the same authenticated run the append is fenced against.
 *
 * THE GRANT IS THE GATE KIND'S, AND IT IS CHARGED WHERE THE KIND IS KNOWN. Which
 * grant a gate costs depends on the kind the PLAN declares, so it cannot be
 * charged by the service's construction-time table the way a fixed-grant
 * operation's is. `authorGateProof` charges it against the loaded kind; the
 * pre-filter here refuses a caller holding no gate grant at all before any lock
 * is taken, and it is derived from the same map rather than restating it, so the
 * coarse check can never admit a kind the exact check would refuse.
 */

import { RecoveryGateError, acquireMutationLock } from "../operation-bundles/lock-gate.js";
// The same pairing the gate documents: the gate acquires, utils releases.
import { releaseLock } from "../utils/lock.js";
import {
  GATE_DECIDING_GRANTS, GATE_DECISIONS, GateAuthorityError, authorGateProof,
} from "./gates.js";
import type { GateDecision } from "./gates.js";
import { isSafeComponent } from "./ids.js";
import type { GateProofId } from "./ids.js";
import { preparationRunActor, principalHasGrant } from "./principals.js";
import type { PreparationPrincipal } from "./principals.js";
import { preparationRunPredecessor } from "./run-integrity.js";
import { appendProjectedTransitionLocked } from "./run-store.js";
import type { PreparationRunContentProjector } from "./run-store.js";
import type {
  AppendPreparationTransitionInput, GateProofSummaryV1, PreparationRunBinding,
  PreparationRunState, PreparationRunV1,
} from "./run-types.js";
import { stateOnlyTransitionStates } from "./run-validation.js";
import { resolveGateAuthority } from "./service-gate-authority.js";
import { REQUEST_CAPTURE_REFUSAL, capturedRequest } from "./service-request-capture.js";
import { resolveHostReadiness } from "./service-readiness.js";
import { resolvePreparationRun } from "./service-run-lookup.js";

/** Request for the `gate` operation. Carries no actor, surface or grant. */
export interface GateRequestV1 {
  /** The run whose gate is being decided. */
  readonly runId: string;
  /** The gate id the run's own plan declares. */
  readonly gateId: string;
  /** The operator's exact choice, from the three closed decisions. */
  readonly decision: GateDecision;
  /** An optional bounded reason code recorded on the proof. */
  readonly reasonCode?: string;
}

/** The closed outcome of one gate decision. */
export type GateResultV1 =
  | {
    readonly status: "recorded";
    readonly runId: string;
    readonly gateId: string;
    readonly gateProofId: GateProofId;
    readonly decision: GateDecision;
    /** The host-derived index this decision was recorded under. */
    readonly decisionIndex: number;
  }
  | { readonly status: "refused"; readonly reason: string };

/**
 * The run states at which a gate decision can be recorded WITHOUT moving the run.
 *
 * DERIVED from the transition type's own admissible targets intersected with the
 * states that admit their own edge, because "records authority and performs
 * nothing" IS the requirement that the run does not move. Hand-writing it would
 * have produced a set that disagrees with the validator: `gate-decided` may also
 * target `recovery-required`, which has no self-edge, so a record-only append is
 * impossible there — a fact worth deriving rather than remembering.
 */
export const GATE_RECORDABLE_RUN_STATES: ReadonlySet<PreparationRunState> =
  stateOnlyTransitionStates("gate-decided");

/** Project the authored summary onto the run's own gate-proof ledger. */
function gateProofProjector(summary: GateProofSummaryV1): PreparationRunContentProjector {
  return (next) => ({ ...next, gateProofs: [...next.gateProofs, summary] });
}

/** The next decision index for this gate, from the run's own recorded proofs. */
function nextDecisionIndex(run: PreparationRunV1, gateId: string): number {
  return run.gateProofs.filter((proof) => proof.gateId === gateId).length;
}

/** Everything one recorded decision needs, already resolved under the lock. */
interface RecordGateInput {
  readonly root: string;
  readonly binding: PreparationRunBinding;
  readonly run: PreparationRunV1;
  readonly principal: PreparationPrincipal;
  readonly request: GateRequestV1;
  readonly at: string;
}

/**
 * Author the proof and persist it atomically with its transition.
 *
 * The result is read back out of the RETURNED run — the record the writer
 * re-parsed and re-verified — rather than off the summary this function built, so
 * what the caller is told is what the durable ledger holds.
 */
async function recordGateLocked(
  input: RecordGateInput, authoritative: Parameters<typeof authorGateProof>[0]["authoritative"],
): Promise<GateResultV1> {
  const { summary } = authorGateProof({
    principal: input.principal, choice: input.request.decision,
    decisionIndex: nextDecisionIndex(input.run, input.request.gateId),
    at: input.at, authoritative,
    ...(input.request.reasonCode === undefined ? {} : { reasonCode: input.request.reasonCode }),
  });
  const transition: AppendPreparationTransitionInput = {
    type: "gate-decided", stateAfter: input.run.state, actor: preparationRunActor(input.principal),
    at: input.at, payload: { kind: "gate", gateProofId: summary.gateProofId, decision: summary.decision },
  };
  const next = await appendProjectedTransitionLocked(
    input.root, input.binding, preparationRunPredecessor(input.run), transition,
    gateProofProjector(summary),
  );
  const persisted = next.gateProofs.find((proof) => proof.gateProofId === summary.gateProofId);
  return persisted === undefined
    ? { status: "refused", reason: "the gate decision was written but the run does not carry it" }
    : {
      status: "recorded", runId: input.request.runId, gateId: persisted.gateId,
      gateProofId: persisted.gateProofId, decision: persisted.decision,
      decisionIndex: persisted.decisionIndex,
    };
}

/** Resolve the run, check it may carry a decision, and record one. */
async function gateLocked(
  root: string, principal: PreparationPrincipal, request: GateRequestV1, at: string,
): Promise<GateResultV1> {
  const resolved = await resolvePreparationRun(root, request.runId);
  if (!resolved.ok) return { status: "refused", reason: resolved.reason };
  if (!GATE_RECORDABLE_RUN_STATES.has(resolved.run.state)) {
    return {
      status: "refused",
      reason: `a gate decision cannot be recorded while this run is ${resolved.run.state}; `
        + "it is recordable only where the run does not move to carry it",
    };
  }
  const authority = await resolveGateAuthority(root, resolved.binding, resolved.run, request.gateId);
  if (!authority.ok) return { status: "refused", reason: authority.reason };
  const input: RecordGateInput = {
    root, binding: resolved.binding, run: resolved.run, principal, request, at,
  };
  try {
    return await recordGateLocked(input, authority.authoritative);
  } catch (error) {
    // A GATE-shaped refusal is host data failing its own closed vocabulary — a
    // returned refusal, like every other does-not-qualify answer here. An
    // AUTHORITY refusal is deliberately NOT caught: `authorGateProof` charges the
    // kind's grant, and a missing grant must reach the caller as the same thrown
    // `PrincipalAuthorityError` every other operation raises.
    if (error instanceof GateAuthorityError) return { status: "refused", reason: error.message };
    throw error;
  }
}

/**
 * Record one gate decision on a preparation run.
 *
 * `principal` is already captured and already surface-checked by the service
 * composition; its gate grant is charged inside `authorGateProof` against the
 * kind the run's own plan declares.
 *
 * @param root - The project root this invocation acts within.
 * @param principal - The captured host principal the decision is credited to.
 * @param request - The run, gate, decision and optional reason the caller named.
 * @returns The recorded proof identity, or the honest reason none was recorded.
 */
export async function gatePreparationOperation(
  root: string, principal: PreparationPrincipal, request: GateRequestV1,
): Promise<GateResultV1> {
  // CAPTURED IN THE SYNCHRONOUS PROLOGUE (D-10-9), read once and threaded. A
  // field re-read after an await retargets the decision at a gate or a run the
  // caller never named — the defect `stage` and `fail` both carry the fix for.
  //
  // BY DESCRIPTOR FIRST, then allowlist-constructed. The four fields were plain
  // `[[Get]]`s, and `reasonCode` was read TWICE in one expression — once to test
  // for `undefined` and once to store — so a getter answering differently across
  // the two let the admissibility check below pass on one string while a
  // different one reached the signed proof leaf. Reading own data descriptors
  // makes a second answer impossible rather than merely unlikely.
  const own = capturedRequest<GateRequestV1>(request);
  if (own === null) return { status: "refused", reason: REQUEST_CAPTURE_REFUSAL };
  const reasonCode = own.reasonCode;
  const captured: GateRequestV1 = {
    runId: own.runId, gateId: own.gateId, decision: own.decision,
    ...(reasonCode === undefined ? {} : { reasonCode }),
  };
  if (!GATE_DECISIONS.includes(captured.decision)) {
    return { status: "refused", reason: `"${String(captured.decision)}" is not one of the three gate decisions` };
  }
  // CHECKED THROUGH THE PARSER'S OWN RULE, before any work. The reason code goes
  // onto a signed leaf and the run loader re-reads it as a bounded component, so
  // an inadmissible one would otherwise fail INSIDE the durable append — an
  // untyped throw out of a service whose every other decline is a returned value,
  // for an operator who simply typed a space. Restating the rule here would be a
  // check that can disagree with its executor, so it routes through the same
  // assert rather than a second copy of the grammar.
  if (captured.reasonCode !== undefined && !isSafeComponent(captured.reasonCode)) {
    return {
      status: "refused",
      reason: "the reason code must be a short filename-safe component (no spaces, slashes or control characters)",
    };
  }
  // BEFORE ANY LOCK. A caller holding none of the gate grants can decide no gate
  // of any kind, so taking the project lock to discover that would let an
  // ungranted caller block every mutating operation for the duration of a read.
  if (![...GATE_DECIDING_GRANTS].some((grant) => principalHasGrant(principal, grant))) {
    return { status: "refused", reason: "this principal holds no gate-deciding grant" };
  }
  // READINESS FIRST. This operation writes durable key-bound run state, so a
  // project whose own configuration cannot be read is not one it can act in.
  const ready = await resolveHostReadiness(root);
  if (!ready.ready) return { status: "refused", reason: ready.reason ?? "the project is not ready" };
  // BOTH WAYS THE GATED ACQUISITION DECLINES ARE ANSWERS, and only the busy one
  // was carried. `acquireMutationLock` refuses at `review` while any lifecycle
  // unit is pending, and that refusal threw — giving `--json` an empty envelope
  // in the exact state an operator reaches while repairing a project whose key
  // is gone. It was unreachable until a reset surface shipped, which is why the
  // comment below argued the point for one arm and not the other.
  let acquired: boolean;
  try {
    acquired = await acquireMutationLock(root, "review");
  } catch (error) {
    if (error instanceof RecoveryGateError) return { status: "refused", reason: error.message };
    throw error;
  }
  // A REFUSAL, not a throw: a busy lock means nothing happened.
  if (!acquired) return { status: "refused", reason: "project lock is busy" };
  try {
    return await gateLocked(root, principal, captured, new Date().toISOString());
  } finally {
    await releaseLock(root);
  }
}
