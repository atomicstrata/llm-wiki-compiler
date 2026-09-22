/**
 * @file src/preparations/run-validation.ts
 * @description Closed genesis, sequence, hash-chain, legal-edge, effect-safety,
 * and terminal-rule validation for the version-one preparation run (design
 * sections 12.3, 14.1, 14.4). Interior removal or reordering is detectable
 * through the sequence and hash chain; an impossible terminal, an outcome-unknown
 * effect in a settled state, and a handoff/supersession/residual mismatch all
 * fail closed here, before the run store trusts any state.
 */

import type {
  BrokerRequestSummaryV1, EffectSummaryV1, PreparationRunState,
  PreparationRunTransitionV1, PreparationRunV1, PreparationTransitionType,
} from "./run-types.js";

const SUCCESS_STATES = new Set<PreparationRunState>([
  "succeeded", "succeeded-with-warnings", "handed-off",
]);
/**
 * The states in which an execution owner may be recorded — a run with work in
 * flight.
 *
 * EXPORTED so a caller asking "could this run be BUSY?" reads the same set the
 * validator enforces. A second copy is how a sweep comes to treat a state as
 * quiescent that the validator still admits an owner in, which is how a live
 * executor's fence gets cleared out from under it.
 */
export const OWNER_ACTIVE_STATES: ReadonlySet<PreparationRunState> = new Set<PreparationRunState>([
  "running", "paused", "cancelling", "handoff-started", "awaiting-gate",
]);
/**
 * The settlement and terminal states in which every external effect must carry a
 * settled honest outcome and every broker request must be resolved (design
 * section 14.4). A durably STARTED-but-unreceipted effect is strictly less
 * resolved than `outcome-unknown`, so these states forbid it too.
 *
 * EXPORTED so a conformance test can cross-check this hand-written list against
 * the edge-derived terminal set: every terminal state (abandoned excepted — it
 * preserves residual findings by confirmation) plus the handoff-ready
 * settlement checkpoint. A member silently drifting out of this set is exactly
 * how a false terminal over an unsettled effect (PO-INV-30) would land.
 */
export const UNRESOLVED_EFFECT_FORBIDDEN: ReadonlySet<PreparationRunState> = new Set<PreparationRunState>([
  "failed", "cancelled", "cancelled-with-effects", "superseded", "handoff-ready",
  "succeeded", "succeeded-with-warnings", "handed-off",
]);

/** The effect outcomes that count as a settled, honest, terminal resolution. */
const SETTLED_EFFECT_OUTCOMES = new Set<EffectSummaryV1["outcome"]>([
  "applied", "already-applied", "refused", "unavailable", "failed",
]);

/** The broker-request states that count as resolved (not still pending). */
const RESOLVED_BROKER_STATES = new Set<BrokerRequestSummaryV1["state"]>([
  "settled", "unavailable",
]);

/**
 * Every legal state edge.
 *
 * EXPORTED so a caller can ask "may this run reach X" BEFORE attempting the
 * append, instead of discovering it as a thrown validator string. The validator
 * below stays the enforcement; a caller reading the same table cannot drift
 * from it, which is the whole reason it is shared rather than restated.
 */
export const LEGAL_EDGES: Readonly<Record<PreparationRunState, ReadonlySet<PreparationRunState>>> = {
  planned: new Set(["awaiting-gate", "running", "cancelling", "recovery-required", "superseded", "failed"]),
  "awaiting-gate": new Set(["awaiting-gate", "running", "paused", "cancelling", "recovery-required", "failed", "superseded"]),
  running: new Set(["running", "awaiting-gate", "paused", "cancelling", "recovery-required", "handoff-ready", "succeeded", "succeeded-with-warnings", "failed"]),
  paused: new Set(["running", "cancelling", "recovery-required", "failed"]),
  cancelling: new Set(["cancelled", "cancelled-with-effects", "recovery-required"]),
  "recovery-required": new Set(["running", "cancelling", "failed", "abandoned", "superseded", "cancelled", "cancelled-with-effects", "handoff-ready"]),
  "handoff-ready": new Set(["handoff-started", "cancelling", "recovery-required"]),
  "handoff-started": new Set(["handed-off", "recovery-required"]),
  "handed-off": new Set(), succeeded: new Set(), "succeeded-with-warnings": new Set(),
  failed: new Set(), cancelled: new Set(), "cancelled-with-effects": new Set(),
  superseded: new Set(), abandoned: new Set(),
};

/**
 * The states with NO outgoing edge — DERIVED, never restated.
 *
 * It was a hand-written set beside the table it duplicates. The two agreed, and
 * nothing made them: a state losing its last outgoing edge is exactly how they
 * would come to disagree, silently, with the validator enforcing one answer and
 * every reader of the table seeing the other. Deriving it is cheaper than the
 * equality assertion it replaces and cannot be forgotten.
 */
const TERMINAL_STATES: ReadonlySet<PreparationRunState> = new Set(
  (Object.keys(LEGAL_EDGES) as PreparationRunState[])
    .filter((state) => LEGAL_EDGES[state].size === 0),
);

const TYPE_TARGET: Readonly<Record<PreparationTransitionType, ReadonlySet<PreparationRunState>>> = {
  "run-planned": new Set(["planned"]), "gate-blocked": new Set(["awaiting-gate"]),
  "gate-decided": new Set(["running", "awaiting-gate", "recovery-required"]),
  "phase-started": new Set(["running"]), "phase-progressed": new Set(["running", "awaiting-gate"]),
  "phase-settled": new Set(["running", "awaiting-gate"]), paused: new Set(["paused"]),
  resumed: new Set(["running"]), "recovery-required": new Set(["recovery-required"]),
  "recovery-resumed": new Set(["running"]), "handoff-ready": new Set(["handoff-ready"]),
  "handoff-started": new Set(["handoff-started"]), "handed-off": new Set(["handed-off"]),
  succeeded: new Set(["succeeded"]), "succeeded-with-warnings": new Set(["succeeded-with-warnings"]),
  cancelling: new Set(["cancelling"]), cancelled: new Set(["cancelled"]),
  "cancelled-with-effects": new Set(["cancelled-with-effects"]), superseded: new Set(["superseded"]),
  abandoned: new Set(["abandoned"]), failed: new Set(["failed"]),
  "headroom-exhausted": new Set(["recovery-required"]),
  "notice-recorded": new Set(), "warning-recorded": new Set(),
};

/**
 * Annotation transition types that record a fact without changing run state.
 * A `notice-recorded` is legal from ANY state, including a terminal one: the
 * design (sections 19.3 and 23.2) intends post-terminal informational notices
 * such as `cancellation-arrived-after-completion` on an already-succeeded or
 * handed-off run. A `warning-recorded` determines the terminal outcome
 * (`succeeded-with-warnings`), so it may only be recorded before terminality;
 * a post-terminal warning is contradictory and is rejected. Both are bounded by
 * the 3,200-transition array cap enforced in the loader, so post-terminal
 * notices cannot grow a record without limit.
 */
const SELF_TYPES = new Set<PreparationTransitionType>(["notice-recorded", "warning-recorded"]);

/** Every declared run state, derived from the edge table's own keys. */
const ALL_RUN_STATES = Object.keys(LEGAL_EDGES) as readonly PreparationRunState[];

/**
 * The states at which a transition of `type` may be appended WITHOUT moving the
 * run — the type may target the state, and the state's edge set admits itself.
 *
 * EXPORTED and DERIVED FROM BOTH TABLES, because an operation that RECORDS
 * authority and performs nothing needs exactly this set and has no other way to
 * compute it: `TYPE_TARGET` alone admits states the edge table refuses
 * (`gate-decided` may target `recovery-required`, which has no self-edge), and
 * `LEGAL_EDGES` alone admits states the type cannot produce. A caller that
 * hand-wrote the intersection would be a check that can disagree with the
 * validator enforcing it — either attempting an append that throws an untyped
 * validator string, or refusing where the validator would have allowed.
 *
 * @param type - The transition type the caller intends to append.
 * @returns The states from which that append leaves the run where it was.
 */
export function stateOnlyTransitionStates(
  type: PreparationTransitionType,
): ReadonlySet<PreparationRunState> {
  // An annotation type bypasses `TYPE_TARGET` entirely in the validator, so its
  // admissible set is derived from the validator's OWN annotation rule rather
  // than from a table that records an empty target for it.
  if (SELF_TYPES.has(type)) {
    return new Set(type === "warning-recorded"
      ? ALL_RUN_STATES.filter((state) => !TERMINAL_STATES.has(state))
      : ALL_RUN_STATES);
  }
  return new Set([...TYPE_TARGET[type]].filter((state) => LEGAL_EDGES[state].has(state)));
}

/** Validate the sole genesis transition. */
function assertGenesis(genesis: PreparationRunTransitionV1): void {
  if (genesis.sequence !== 0 || genesis.previousHash !== null || genesis.type !== "run-planned"
    || genesis.stateBefore !== "planned" || genesis.stateAfter !== "planned") {
    throw new Error("preparation run genesis is invalid");
  }
}

/** Validate one non-genesis transition against its exact predecessor. */
function assertChainStep(prior: PreparationRunTransitionV1, current: PreparationRunTransitionV1, index: number): void {
  if (current.sequence !== index) throw new Error("preparation transition sequence is not monotonic");
  if (current.previousHash !== prior.contentHash) throw new Error("preparation transition chain is broken");
  if (current.stateBefore !== prior.stateAfter) throw new Error("preparation transition stateBefore is not the prior stateAfter");
  assertLegalEdge(current);
}

/** Validate one transition's type-to-target and legal state edge. */
function assertLegalEdge(current: PreparationRunTransitionV1): void {
  if (SELF_TYPES.has(current.type)) {
    if (current.stateAfter !== current.stateBefore) throw new Error("annotation transition may not change run state");
    if (current.type === "warning-recorded" && TERMINAL_STATES.has(current.stateBefore)) {
      throw new Error("a completion warning cannot be recorded after a terminal state");
    }
    return;
  }
  if (!TYPE_TARGET[current.type].has(current.stateAfter)) throw new Error("transition type does not produce its recorded state");
  if (!LEGAL_EDGES[current.stateBefore].has(current.stateAfter)) throw new Error("illegal preparation run state edge");
}

/** Validate genesis, monotonic sequence, the hash chain, and every legal edge. */
function assertTransitionChain(run: PreparationRunV1): void {
  const transitions = run.transitions;
  if (transitions.length === 0) throw new Error("preparation run has no genesis transition");
  assertGenesis(transitions[0]!);
  for (let index = 1; index < transitions.length; index++) {
    assertChainStep(transitions[index - 1]!, transitions[index]!, index);
  }
  if (run.stateVersion !== transitions.length) throw new Error("preparation run stateVersion is not the transition count");
  if (transitions.at(-1)!.stateAfter !== run.state) throw new Error("preparation run state is not the final transition state");
}

/** Enforce that every phase is consistent with a terminal success. */
function assertSuccessPhases(run: PreparationRunV1): void {
  for (const phase of run.phaseSummaries) {
    if (phase.disposition === "required" && phase.state !== "succeeded" && phase.state !== "succeeded-with-warnings") {
      throw new Error("success requires every required phase to succeed");
    }
    if (phase.state === "recovery-required") throw new Error("success cannot carry a recovery-required phase");
  }
}

/** Enforce the success terminal preconditions (design section 14.4). */
function assertSuccessRules(run: PreparationRunV1): void {
  if (run.completeness.requiredDeficit !== 0) throw new Error("success requires no completeness deficit");
  if (run.residualFindings.length !== 0) throw new Error("success cannot carry residual findings");
  assertSuccessPhases(run);
  if (run.state === "succeeded" && run.completionWarnings.length !== 0) {
    throw new Error("strict success cannot carry completion warnings");
  }
}

/** Enforce handoff, supersession, residual, cancellation, and effect coupling. */
function assertStateCoupling(run: PreparationRunV1): void {
  if ((run.handoff !== undefined) !== (run.state === "handed-off")) throw new Error("handoff binding must exist exactly when handed-off");
  if ((run.supersededByPreparationId !== undefined) !== (run.state === "superseded")) throw new Error("supersession id must exist exactly when superseded");
  if (run.residualFindings.length > 0 && run.state !== "abandoned") throw new Error("residual findings are abandonment-only");
  if (run.executionOwner !== undefined && !OWNER_ACTIVE_STATES.has(run.state)) throw new Error("execution owner is only valid while work is in flight");
  assertEffectRules(run);
}

/** The effect outcomes that prove a mutation was applied at the target. */
function isAppliedEffect(effect: EffectSummaryV1): boolean {
  return effect.outcome === "applied" || effect.outcome === "already-applied";
}

/**
 * Report whether the run's authenticated ledger records any applied external
 * effect. EXPORTED so a caller choosing between `cancelled` and
 * `cancelled-with-effects` reads the same applied-effect definition the terminal
 * rules below enforce, rather than a second copy of it.
 */
export function runHasAppliedEffect(run: PreparationRunV1): boolean {
  return run.effectSummaries.some(isAppliedEffect);
}

/** Why one run's effect/broker ledger is not fully and honestly resolved. */
export type UnresolvedLedgerReason =
  | { readonly kind: "unresolved-effect"; readonly outcome: EffectSummaryV1["outcome"] }
  | { readonly kind: "pending-broker-request" }
  | { readonly kind: "unauthenticated-applied-effect" };

/**
 * The SINGLE ledger-resolution predicate: every external effect carries a settled
 * honest outcome (never `planned`, `started`, or `outcome-unknown`), every broker
 * request is resolved, and every applied effect is authenticated by a host
 * receipt digest AND a matching settled broker request for the same attempt — an
 * `applied` outcome with either missing is an unproven mutation claim (design
 * section 18.2).
 *
 * EXPORTED for the same reason {@link LEGAL_EDGES} is: a caller deciding whether
 * a run MAY reach a settled terminal must read the exact predicate the validator
 * enforces, not a second copy that can drift from it. {@link assertEffectRules}
 * is its only enforcement site, so the check and the executor cannot disagree.
 */
export function unresolvedLedgerReason(run: PreparationRunV1): UnresolvedLedgerReason | null {
  const unresolved = run.effectSummaries.find((effect) => !SETTLED_EFFECT_OUTCOMES.has(effect.outcome));
  if (unresolved !== undefined) return { kind: "unresolved-effect", outcome: unresolved.outcome };
  if (run.brokerRequestSummaries.some((request) => !RESOLVED_BROKER_STATES.has(request.state))) {
    return { kind: "pending-broker-request" };
  }
  const unauthenticated = run.effectSummaries.some(
    (effect) => isAppliedEffect(effect) && !appliedEffectIsAuthenticated(run, effect),
  );
  return unauthenticated ? { kind: "unauthenticated-applied-effect" } : null;
}

/** An applied effect is authenticated by its receipt AND its settled broker request. */
function appliedEffectIsAuthenticated(run: PreparationRunV1, effect: EffectSummaryV1): boolean {
  return effect.receiptDigest !== undefined
    && run.brokerRequestSummaries.some((request) => request.attemptId === effect.attemptId && request.state === "settled");
}

/** The stable failure message for one unresolved-ledger reason. */
function ledgerMessage(reason: UnresolvedLedgerReason): string {
  if (reason.kind === "unresolved-effect") {
    return `a settled preparation state forbids an unresolved "${reason.outcome}" external effect`;
  }
  if (reason.kind === "pending-broker-request") return "a settled preparation state forbids a pending broker request";
  return "an applied external effect requires a receipt and a settled broker request";
}

/**
 * Enforce the settled-resolution safety rule and cancellation effect coupling
 * (design section 14.4). In a settlement or terminal state the ledger must be
 * fully resolved, so a durably started-but-unreceipted effect can never be
 * silently lost into a success or other terminal state.
 */
function assertEffectRules(run: PreparationRunV1): void {
  if (UNRESOLVED_EFFECT_FORBIDDEN.has(run.state)) {
    const unresolved = unresolvedLedgerReason(run);
    if (unresolved !== null) throw new Error(ledgerMessage(unresolved));
  }
  const applied = runHasAppliedEffect(run);
  if (run.state === "cancelled" && applied) throw new Error("cancelled requires no applied external effect");
  if (run.state === "cancelled-with-effects" && !applied) throw new Error("cancelled-with-effects requires an applied external effect");
}

/** Validate the complete parsed run beyond its per-field grammar. */
export function validatePreparationRun(run: PreparationRunV1): void {
  assertTransitionChain(run);
  if (SUCCESS_STATES.has(run.state)) assertSuccessRules(run);
  assertStateCoupling(run);
}
