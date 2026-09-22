/**
 * @file src/preparations/gates.ts
 * @description Host-authored, digest-bound preparation gate authority (design
 * sections 17.1, 17.3, 17.4). Only the eight closed gate kinds are decidable and
 * only the three closed decisions are recordable; anything else fails closed. A
 * gate proof binds the run, plan, gate, phase, current input, current effect, and
 * authority digests, the exact operator choice, the actor principal, the decision
 * index, and the timestamp — and EVERY bound digest is recomputed here from the
 * host's authoritative current state, never accepted as a caller-asserted value.
 * A decision over old bytes is not reusable after revision: freshness recomputes
 * the current bound digests and any change renders an approval unusable. Pack and
 * provider prose may relabel a gate for a product, but cannot define a new gate
 * kind, widen a decision, or supply a fact — those are host authority alone.
 */

import { canonicalDigest } from "../profile/templates/signing/canonical.js";
import { parseSha256Digest } from "../capability-providers/ids.js";
import { deriveGateProofId, type GateProofId, type PhaseInstanceId, type PreparationRunId } from "./ids.js";
import {
  capturePreparationPrincipal, preparationRunActor, requirePreparationGrant,
  type PreparationGrant, type PreparationPrincipal,
} from "./principals.js";
import type { NormalizedPreparationPlanV1, PhaseGateContractV1, PhaseGateKind } from "./plan-types.js";
import type { GateProofSummaryV1, PreparationPrincipalV1 } from "./run-types.js";
import type { EvidenceRefV1, Sha256Digest } from "./types.js";

/** The domain string separating a gate-fact digest from every other digest. */
const GATE_FACT_DOMAIN = "llmwiki-preparation-gate-fact-v1";

/** The three closed gate decisions (design section 17). */
export const GATE_DECISIONS = Object.freeze(["approved", "rejected", "revised"] as const);

export type GateDecision = (typeof GATE_DECISIONS)[number];

/** The eight closed gate kinds allowed by the contract (design section 17.1). */
export const PREPARATION_GATE_KINDS = Object.freeze([
  "confirm-input-exposure", "confirm-cost", "confirm-external-effect",
  "confirm-residual-risk", "review-selection", "review-preparation",
  "discussion-checkpoint", "confirm-abandonment",
] as const);

/**
 * The closed gate-kind to required-grant map. Exposure, cost, effect, and
 * residual-risk gates gate a mutating external boundary and require the effect
 * approval grant; the review/discussion gates require the non-effect gate grant;
 * abandonment requires the terminal abandonment grant (design section 17.2).
 */
const GATE_GRANT: Readonly<Record<PhaseGateKind, PreparationGrant>> = Object.freeze({
  "confirm-input-exposure": "preparation.effect.approve",
  "confirm-cost": "preparation.effect.approve",
  "confirm-external-effect": "preparation.effect.approve",
  "confirm-residual-risk": "preparation.effect.approve",
  "review-selection": "preparation.gate.decide",
  "review-preparation": "preparation.gate.decide",
  "discussion-checkpoint": "preparation.gate.decide",
  "confirm-abandonment": "preparation.abandon",
});

/**
 * The distinct grants that decide SOME gate — derived from the map's own values.
 *
 * A surface that must answer "may this caller decide any gate at all?" before it
 * reads a run and takes a lock needs this set, and a hand-written copy of it
 * would silently stop covering a kind whose grant later changed. It is a
 * PRE-FILTER and never the authorization: the exact per-kind grant is charged by
 * {@link authorGateProof} against the kind loaded from the host's own plan, so a
 * caller holding one gate grant still cannot decide a gate that needs another.
 */
export const GATE_DECIDING_GRANTS: ReadonlySet<PreparationGrant> =
  new Set(Object.values(GATE_GRANT));

/** Closed reason a gate decision or reliance failed closed. */
export type GateAuthorityCode =
  | "unknown-gate-kind" | "unknown-decision" | "not-approved" | "not-fresh";

/** Typed refusal raised for every gate authority failure. */
export class GateAuthorityError extends Error {
  readonly code: GateAuthorityCode;
  constructor(code: GateAuthorityCode) {
    super(`preparation gate authority: ${code}`);
    this.name = "GateAuthorityError";
    this.code = code;
  }
}

/**
 * The host's authoritative current state for one gate decision. Every field is
 * host-loaded from the authenticated manifest, plan, and run — the deciding
 * caller supplies only the choice and index, never a digest.
 */
export interface GateAuthorityState {
  readonly runId: PreparationRunId;
  readonly plan: NormalizedPreparationPlanV1;
  readonly gate: PhaseGateContractV1;
  readonly phaseInstanceId: PhaseInstanceId;
  readonly currentInput: EvidenceRefV1;
  readonly currentEffectPlanDigest?: Sha256Digest;
}

/** The exact digest set a gate proof binds, each recomputed from current state. */
export interface GateBoundDigestsV1 {
  readonly planDigest: Sha256Digest;
  readonly phaseDigest: Sha256Digest;
  readonly inputDigest: Sha256Digest;
  readonly effectDigest?: Sha256Digest;
  readonly authorityDigest: Sha256Digest;
}

/** One host-authored gate fact and its self-contained bound digest. */
export interface GateFactV1 {
  readonly schemaVersion: 1;
  readonly gateProofId: GateProofId;
  readonly runId: PreparationRunId;
  readonly gateId: string;
  readonly gateKind: PhaseGateKind;
  readonly decision: GateDecision;
  readonly decisionIndex: number;
  readonly at: string;
  readonly actor: PreparationPrincipalV1;
  readonly bound: GateBoundDigestsV1;
  readonly boundDigest: Sha256Digest;
  readonly reasonCode?: string;
}

/** The deciding caller's exact choice over one authoritative gate state. */
export interface GateDecisionInput {
  readonly principal: PreparationPrincipal;
  readonly choice: GateDecision;
  readonly decisionIndex: number;
  readonly at: string;
  readonly authoritative: GateAuthorityState;
  readonly reasonCode?: string;
}

/** Recompute the exact authority-grant digest from the plan's authority refs. */
export function planAuthorityDigest(plan: NormalizedPreparationPlanV1): Sha256Digest {
  return parseSha256Digest(canonicalDigest({
    knowledge: plan.knowledgeAuthority,
    operations: plan.operationsAuthority,
    action: plan.actionAuthority,
    recipe: plan.recipeDigest,
    safetyFloor: plan.safetyFloorDigest,
  }));
}

/** Recompute the exact phase-binding digest for one phase instance (single-source). */
export function phaseBindingDigest(phaseInstanceId: PhaseInstanceId): Sha256Digest {
  return parseSha256Digest(canonicalDigest({ phaseInstanceId }));
}

/** Recompute every gate-bound digest from the host's authoritative state. */
function boundDigests(state: GateAuthorityState): GateBoundDigestsV1 {
  return {
    planDigest: parseSha256Digest(canonicalDigest(state.plan)),
    phaseDigest: phaseBindingDigest(state.phaseInstanceId),
    inputDigest: parseSha256Digest(state.currentInput.digest),
    ...(state.currentEffectPlanDigest === undefined
      ? {} : { effectDigest: parseSha256Digest(state.currentEffectPlanDigest) }),
    authorityDigest: planAuthorityDigest(state.plan),
  };
}

/** Bind the whole fact into one canonical, domain-separated digest. */
function factDigest(
  runId: PreparationRunId, gate: PhaseGateContractV1, decision: GateDecision,
  decisionIndex: number, at: string, actor: PreparationPrincipalV1,
  bound: GateBoundDigestsV1, reasonCode: string | undefined,
): Sha256Digest {
  return parseSha256Digest(canonicalDigest({
    domain: GATE_FACT_DOMAIN, runId, gateId: gate.gateId, gateKind: gate.gateKind,
    decision, decisionIndex, at, actor, bound, reasonCode: reasonCode ?? null,
  }));
}

/** Validate the gate kind is one of the eight closed contract kinds. */
function requireKnownGateKind(kind: PhaseGateKind): PhaseGateKind {
  if (!PREPARATION_GATE_KINDS.includes(kind)) throw new GateAuthorityError("unknown-gate-kind");
  return kind;
}

/** Validate the decision is one of the three closed decisions. */
function requireKnownDecision(choice: GateDecision): GateDecision {
  if (!GATE_DECISIONS.includes(choice)) throw new GateAuthorityError("unknown-decision");
  return choice;
}

/** One authored gate proof: the run summary and the host-authored fact. */
export interface AuthoredGateProof {
  readonly summary: GateProofSummaryV1;
  readonly fact: GateFactV1;
}

/**
 * Author one host gate proof over authoritative current state. The gate kind and
 * decision are checked against their closed allowlists, the deciding principal
 * must hold the kind's required grant, every bound digest is recomputed here, and
 * the proof id is derived from the recomputed plan digest so a forged or stale
 * digest cannot be smuggled into the proof.
 */
export function authorGateProof(input: GateDecisionInput): AuthoredGateProof {
  const principal = capturePreparationPrincipal(input.principal);
  const gateKind = requireKnownGateKind(input.authoritative.gate.gateKind);
  const decision = requireKnownDecision(input.choice);
  requirePreparationGrant(principal, GATE_GRANT[gateKind]);
  const bound = boundDigests(input.authoritative);
  const actor = preparationRunActor(principal);
  const gateId = input.authoritative.gate.gateId;
  const gateProofId = deriveGateProofId({
    runId: input.authoritative.runId, gateId, planDigest: bound.planDigest, decisionIndex: input.decisionIndex,
  });
  const boundDigest = factDigest(
    input.authoritative.runId, input.authoritative.gate, decision, input.decisionIndex, input.at, actor, bound, input.reasonCode,
  );
  return {
    summary: {
      gateProofId, gateId, decision, decisionIndex: input.decisionIndex, planDigest: bound.planDigest,
      phaseDigest: bound.phaseDigest, inputDigest: bound.inputDigest, authorityDigest: bound.authorityDigest, actor, at: input.at,
      ...(bound.effectDigest === undefined ? {} : { effectDigest: bound.effectDigest }),
      // ON THE SUMMARY AS WELL AS THE FACT. The summary is the only half that is
      // persisted, and the reason code is the operator's stated ground for a
      // rejection — authoritative data, not a label, so fencing it out of the
      // durable record would drop exactly what design 17.3 requires be kept.
      ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
    },
    fact: {
      schemaVersion: 1, gateProofId, runId: input.authoritative.runId, gateId, gateKind, decision,
      decisionIndex: input.decisionIndex, at: input.at, actor, bound, boundDigest,
      ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
    },
  };
}

/** The four freshness states of a recorded gate proof (design section 17.4). */
export type GateFreshness = "current" | "drifted" | "unavailable" | "not-applicable";

/** True when two bound-digest sets agree on every present dimension. */
function boundDigestsMatch(a: GateBoundDigestsV1, b: GateBoundDigestsV1): boolean {
  return a.planDigest === b.planDigest && a.phaseDigest === b.phaseDigest
    && a.inputDigest === b.inputDigest && a.effectDigest === b.effectDigest
    && a.authorityDigest === b.authorityDigest;
}

/**
 * Recompute the current bound digests and compare them to a recorded proof. A
 * `discussion-checkpoint` gate has no live authority precondition, so it is
 * always `not-applicable`. An explicitly unreadable current state is
 * `unavailable`; any digest change is `drifted`; a full match is `current`.
 */
export function evaluateGateFreshness(
  fact: GateFactV1, current: GateAuthorityState | { readonly unavailable: true },
): GateFreshness {
  if (fact.gateKind === "discussion-checkpoint") return "not-applicable";
  if ("unavailable" in current) return "unavailable";
  return boundDigestsMatch(fact.bound, boundDigests(current)) ? "current" : "drifted";
}

/**
 * Fail closed unless a recorded proof is an approval that is still relied-upon:
 * the decision must be `approved` and freshness must be `current` (or
 * `not-applicable` for a gate with no live precondition). A drifted, unavailable,
 * rejected, or revised proof can never authorize downstream work.
 */
export function requireFreshApproval(
  fact: GateFactV1, current: GateAuthorityState | { readonly unavailable: true },
): void {
  if (fact.decision !== "approved") throw new GateAuthorityError("not-approved");
  const freshness = evaluateGateFreshness(fact, current);
  if (freshness !== "current" && freshness !== "not-applicable") throw new GateAuthorityError("not-fresh");
}

/**
 * The LATEST decision recorded for one gate, or `undefined` when there is none.
 *
 * `decisionIndex` is the ordering, not array position: the ledger is append-only
 * and its order is a write order, while the index is the host-derived sequence
 * the proof id is bound to. A tie is answered `undefined` rather than by picking
 * one — two proofs at the same index for one gate can only come from a record
 * this host did not write (the service derives the index from the gate's own
 * proof count), and choosing between them would be inventing an order.
 */
function latestGateDecision(
  gateProofs: readonly GateProofSummaryV1[], gateId: string,
): GateProofSummaryV1 | undefined {
  let latest: GateProofSummaryV1 | undefined;
  let tied = false;
  for (const proof of gateProofs) {
    if (proof.gateId !== gateId) continue;
    if (latest === undefined || proof.decisionIndex > latest.decisionIndex) {
      latest = proof;
      tied = false;
    } else if (proof.decisionIndex === latest.decisionIndex) {
      tied = true;
    }
  }
  return tied ? undefined : latest;
}

/**
 * Find the gate's operative approval — its LATEST decision, returned only when
 * that decision is an approval bound to the current plan digest.
 *
 * SUPERSESSION IS THE POINT, and an order-insensitive search for "any approval
 * ever" is what this replaces. The ledger is append-only and a gate may be
 * decided repeatedly, so a search that returned the first matching approval let
 * an operator's later REJECTION be inert: approve, then reject, and every
 * consumer still read the approval. Design section 17.3 says a rejection "may
 * cancel future effect-free work" — every consumer of this function is a
 * pre-start check on future work (effect start, follow-up effect, reconciliation
 * settlement), so honouring the latest decision is what gives `rejected` and
 * `revised` any meaning at all. None of them undoes a settled effect, which is
 * the thing 17.3 says a rejection cannot do.
 *
 * A RE-APPROVAL AFTER A REJECTION IS HONOURED, because it is also the latest
 * decision. The operator who changed their mind twice gets the answer they last
 * gave, which is the only reading under which the ledger is a record of intent
 * rather than a high-water mark.
 *
 * The plan-digest match stays exactly as it was and is applied to that latest
 * decision: the effect request is pinned inside the plan the digest covers, so a
 * change to the effect, input, cost, or authority reanchors the plan digest and
 * invalidates the match here. Finer per-dimension drift is enforced separately
 * on the full-fact {@link requireFreshApproval} and durable-summary
 * {@link revalidateApprovedGateProof} paths; this is the cheap run-summary
 * pre-filter, not the whole freshness contract.
 */
export function findApprovedGateProof(
  gateProofs: readonly GateProofSummaryV1[], gateId: string, currentPlanDigest: Sha256Digest,
): GateProofSummaryV1 | undefined {
  const latest = latestGateDecision(gateProofs, gateId);
  if (latest === undefined || latest.decision !== "approved") return undefined;
  return latest.planDigest === currentPlanDigest ? latest : undefined;
}

/** The current authoritative binding an approved gate proof is revalidated against. */
export interface GateProofCurrentBinding {
  readonly planDigest: Sha256Digest;
  readonly phaseDigest: Sha256Digest;
  readonly inputDigest: Sha256Digest;
  readonly effectDigest?: Sha256Digest;
  readonly authorityDigest: Sha256Digest;
}

/**
 * Fail closed unless a persisted approved gate proof still matches the current
 * authoritative binding on EVERY dimension the fact bound — plan, PHASE, input,
 * effect, and authority. This is the durable-summary counterpart of
 * {@link requireFreshApproval}: an approval that would survive phase, input,
 * effect, or authority drift (even without a plan revision) is rejected here
 * before it can authorize an effect. The persisted shape and this binding are the
 * same complete set {@link authorGateProof} computes — nothing is computed and
 * then discarded.
 */
export function revalidateApprovedGateProof(
  proof: GateProofSummaryV1, current: GateProofCurrentBinding,
): void {
  const drifted = proof.planDigest !== current.planDigest
    || proof.phaseDigest !== current.phaseDigest
    || proof.inputDigest !== current.inputDigest
    || proof.effectDigest !== current.effectDigest
    || proof.authorityDigest !== current.authorityDigest;
  if (drifted) throw new GateAuthorityError("not-fresh");
}
