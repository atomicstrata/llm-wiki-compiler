/**
 * @file src/operations-packs/compiler-bounds.ts
 * @description Finite worst-case envelope derivation for a compiled pack action
 * (design sections 15.3, 17). It turns a recipe's scalar bounds sources into the
 * plan's per-phase {@link PhaseBoundsV1}, its handoff capacity contract, and its
 * whole-run {@link PreparationBoundsV1}.
 *
 * ONE RULE, STATED ONCE: a dimension the recipe bounds is DERIVED from the
 * recipe; a dimension the recipe cannot bound is pinned to the host contract that
 * owns it — the registered family's declared descriptor (output bytes, wall time,
 * recovery), the attempt ceiling, or the pinned Milestone A cap. Nothing here
 * invents a number, and nothing is clamped: a recipe whose declared envelope
 * exceeds what the host contract or the launch ceiling admits is REFUSED, because
 * a silently reduced bound is a plan that promises what it cannot deliver.
 *
 * THE RUN ENVELOPE IS NOT RESTATED. `runBoundsFor` declares exactly the envelope
 * {@link computePreparationWorstCase} computes from the lowered phases, so the
 * plan's declared bounds and Orchestration V2's arithmetic agree by construction
 * rather than by two copies of one formula happening to match.
 */

import {
  MAX_ATTEMPTS_PER_PHASE_INSTANCE, MAX_HANDOFF_ACTIVE_STORE_BYTES,
  MAX_HANDOFF_ITEM_PAYLOAD_BYTES, MAX_HANDOFF_MANIFEST_BYTES,
  MAX_HANDOFF_RUN_EVIDENCE_BYTES, MAX_HANDOFF_RUN_EVIDENCE_ITEM_BYTES,
  MAX_LOGICAL_PHASES_PER_PLAN, MILESTONE_A_DESIGN_DIGEST,
} from "../preparations/constants.js";
import { computePreparationWorstCase } from "../preparations/plan-bounds.js";
import type { ProviderRequestedBoundsV2 } from "./types.js";
import type {
  HandoffCapacityPlanV1, NormalizedPreparationPlanV1, PhaseBoundsV1,
  PreparationBoundsV1,
} from "../preparations/plan-types.js";
import type { HostHandlerDescriptorV1 } from "../preparations/attempts/types.js";
import { PackParseError } from "./problems.js";
import type { PackRecipeV2, PhaseBoundsSourceV2 } from "./recipe-types.js";

/**
 * Attempts a compiled phase instance may consume. The recipe declares no retry
 * policy, so the plan declares the platform ceiling: the largest envelope the
 * attempt boundary will ever admit for one instance.
 */
const ATTEMPTS_PER_PHASE_INSTANCE = MAX_ATTEMPTS_PER_PHASE_INSTANCE;

/**
 * Host-handler invocations one attempt makes. The host-handler leg calls
 * `handler.execute` exactly once per attempt, so this is one, not a budget.
 */
const HOST_HANDLER_INVOCATIONS_PER_ATTEMPT = 1;

/**
 * Run-log transitions one attempt appends: `phase-started` and `phase-settled`
 * (the closed transition vocabulary the attempt boundary writes).
 */
const TRANSITIONS_PER_ATTEMPT = 2;

/** Run-log transitions one gate instance appends: `gate-blocked`, `gate-decided`. */
const TRANSITIONS_PER_GATE_INSTANCE = 2;

/** A gate consumes no attempt; the grammar admits no zero, so it declares one. */
const ATTEMPTS_PER_GATE_INSTANCE = 1;

/** Dimensions a host-handler phase provably never consumes (section 16.1). */
const NO_BROKER_REQUESTS = 0;
const NO_EXTERNAL_EFFECTS = 0;
const NO_MODEL_TOKENS = 0;
const NO_HOST_COST_MICROS = 0;

/** A restart-safe family checkpoints nothing; a gate publishes no evidence. */
const NO_CHECKPOINT_BYTES = 0;
const NO_OUTPUT_EVIDENCE_BYTES = 0;
const NO_INVOCATIONS = 0;
const NO_WALL_TIME_MS = 0;

/**
 * Refuse a recipe whose declared shape cannot become a version-one plan at all:
 * more logical phases than a plan may carry, or an output envelope larger than
 * one pinned Milestone A payload item. Both are recipe faults, and refusing them
 * here keeps the compiler's own self-verification a genuine internal check.
 */
export function assertRecipeFitsPlanCeilings(recipe: PackRecipeV2): void {
  if (recipe.phases.length > MAX_LOGICAL_PHASES_PER_PLAN) {
    throw new PackParseError("recipe declares more phases than one plan may carry");
  }
  if (recipe.bounds.maxOutputBytes > MAX_HANDOFF_ITEM_PAYLOAD_BYTES) {
    throw new PackParseError("recipe output bytes exceed the pinned Milestone A payload item cap");
  }
}

/**
 * The per-instance envelope of one host-handler work phase.
 *
 * `maximumOutputEvidenceBytes` is the recipe's declared per-phase output bound,
 * refused when it exceeds what the registered family's contract can emit — the
 * family's cap also equals the pinned run-evidence item cap, so every phase
 * output a compiled plan admits is readable back at materialization time.
 * `maximumTimeMsPerInstance` covers every attempt at the family's declared wall
 * time, so the execution leg may use the family's full contract budget.
 */
/**
 * Build one provider phase's bounds from the role's SEALED request.
 *
 * The pack requests; the operator's grant still decides at invocation, so the
 * effective ceiling is the smaller of the two. Sealing the request here is what
 * makes approving a plan mean approving THAT envelope — a plan whose provider
 * could ask for more after approval would make the digest meaningless.
 *
 * External effects stay at zero: a capability that writes outside the project
 * is an effect-plan concern with its own declaration, not something a phase
 * envelope grants implicitly.
 */
export function providerPhaseBounds(
  requested: ProviderRequestedBoundsV2, source: PhaseBoundsSourceV2,
): PhaseBoundsV1 {
  return {
    maximumAttempts: ATTEMPTS_PER_PHASE_INSTANCE,
    maximumInvocationsPerAttempt: HOST_HANDLER_INVOCATIONS_PER_ATTEMPT,
    maximumBrokerRequestsPerAttempt: requested.maxBrokerRequestsPerAttempt,
    maximumEffectsPerAttempt: NO_EXTERNAL_EFFECTS,
    maximumTransitionsPerInstance: ATTEMPTS_PER_PHASE_INSTANCE * TRANSITIONS_PER_ATTEMPT,
    maximumOutputEvidenceBytes: source.maxOutputBytes,
    maximumCheckpointBytes: NO_CHECKPOINT_BYTES,
    maximumTokensPerAttempt: requested.maxTokensPerAttempt,
    maximumTimeMsPerInstance: ATTEMPTS_PER_PHASE_INSTANCE * requested.maxWallTimeMsPerAttempt,
    maximumCostMicrosPerAttempt: requested.maxCostMicrosPerAttempt,
  };
}

export function hostHandlerPhaseBounds(
  descriptor: HostHandlerDescriptorV1, source: PhaseBoundsSourceV2,
): PhaseBoundsV1 {
  if (source.maxOutputBytes > descriptor.maximumOutputBytes) {
    throw new PackParseError(`phase output bytes exceed the ${descriptor.handlerId} contract`);
  }
  return {
    maximumAttempts: ATTEMPTS_PER_PHASE_INSTANCE,
    maximumInvocationsPerAttempt: HOST_HANDLER_INVOCATIONS_PER_ATTEMPT,
    maximumBrokerRequestsPerAttempt: NO_BROKER_REQUESTS,
    maximumEffectsPerAttempt: NO_EXTERNAL_EFFECTS,
    maximumTransitionsPerInstance: ATTEMPTS_PER_PHASE_INSTANCE * TRANSITIONS_PER_ATTEMPT,
    maximumOutputEvidenceBytes: source.maxOutputBytes,
    maximumCheckpointBytes: NO_CHECKPOINT_BYTES,
    maximumTokensPerAttempt: NO_MODEL_TOKENS,
    maximumTimeMsPerInstance: ATTEMPTS_PER_PHASE_INSTANCE * descriptor.maximumWallTimeMs,
    maximumCostMicrosPerAttempt: NO_HOST_COST_MICROS,
  };
}

/**
 * The per-instance envelope of one gate phase. A gate is never executed as an
 * attempt — the runner's gate driver blocks the run and resumes it on a recorded
 * decision — so it invokes nothing, publishes no phase output evidence, and
 * charges no wall time to an attempt; only its two run-log transitions count.
 */
export function gatePhaseBounds(): PhaseBoundsV1 {
  return {
    maximumAttempts: ATTEMPTS_PER_GATE_INSTANCE,
    maximumInvocationsPerAttempt: NO_INVOCATIONS,
    maximumBrokerRequestsPerAttempt: NO_BROKER_REQUESTS,
    maximumEffectsPerAttempt: NO_EXTERNAL_EFFECTS,
    maximumTransitionsPerInstance: TRANSITIONS_PER_GATE_INSTANCE,
    maximumOutputEvidenceBytes: NO_OUTPUT_EVIDENCE_BYTES,
    maximumCheckpointBytes: NO_CHECKPOINT_BYTES,
    maximumTokensPerAttempt: NO_MODEL_TOKENS,
    maximumTimeMsPerInstance: NO_WALL_TIME_MS,
    maximumCostMicrosPerAttempt: NO_HOST_COST_MICROS,
  };
}

/**
 * The downstream handoff capacity contract, including the FULL materialization
 * triple. The triple is not optional in practice: the runner refuses at entry a
 * plan whose capacity omits or partially declares it, and the stage-time envelope
 * reserves the finalization overhead only when all three are present — a plan
 * admitted exactly at its evidence bounds would otherwise finish every phase and
 * then be unable to persist its obligation.
 *
 * The payload triple is DERIVED from the terminal intent phase: it emits at most
 * its declared item count of drafts within its declared output bytes, and the
 * manifest describing them is the host-authored Milestone A manifest, reserved at
 * the pinned cap the recipe has no way to bound.
 */
export function handoffCapacityFor(
  recipe: PackRecipeV2, terminal: PhaseBoundsSourceV2,
): HandoffCapacityPlanV1 {
  return {
    milestoneADesignDigest: MILESTONE_A_DESIGN_DIGEST,
    includedEvidenceClasses: [{
      classId: recipe.outputContract.evidenceClass,
      maximumItems: recipe.bounds.maxTotalItems,
      maximumItemBytes: recipe.bounds.maxOutputBytes,
      maximumAggregateBytes: recipe.bounds.maxOutputBytes,
    }],
    maximumBundlePayloadBytes: recipe.bounds.maxOutputBytes,
    maximumManifestBytes: MAX_HANDOFF_MANIFEST_BYTES,
    maximumRunEvidenceItemBytes: MAX_HANDOFF_RUN_EVIDENCE_ITEM_BYTES,
    maximumRunEvidenceBytes: MAX_HANDOFF_RUN_EVIDENCE_BYTES,
    maximumActiveStoreContributionBytes: MAX_HANDOFF_ACTIVE_STORE_BYTES,
    maximumMaterializationManifestBytes: MAX_HANDOFF_MANIFEST_BYTES,
    maximumMaterializationPayloadRefs: terminal.maxItems,
    maximumMaterializationPayloadBytes: terminal.maxOutputBytes,
  };
}

/**
 * Declare exactly the envelope Orchestration V2 computes for the lowered phases.
 *
 * The probe is a REAL plan value carrying a zero envelope rather than a cast:
 * the arithmetic reads only the phases and the handoff capacity, and a lie about
 * the object's type would silently pass `undefined` if it ever read more.
 */
export function runBoundsFor(draft: Omit<NormalizedPreparationPlanV1, "bounds">): PreparationBoundsV1 {
  const env = computePreparationWorstCase({ ...draft, bounds: zeroBounds() });
  return {
    maximumPhaseInstances: env.phaseInstances, maximumAttempts: env.attempts,
    maximumInvocations: env.invocations, maximumBrokerRequests: env.brokerRequests,
    maximumEffects: env.effects, maximumTransitions: env.transitions,
    maximumEvidenceRefs: env.evidenceRefs, maximumEvidenceBytes: env.evidenceBytes,
    maximumCheckpointBytes: env.checkpointBytes, maximumTokens: env.tokens,
    maximumTimeMs: env.timeMs, maximumCostMicros: env.costMicros,
  };
}

/** The all-zero declared envelope the worst-case probe carries. */
function zeroBounds(): PreparationBoundsV1 {
  return {
    maximumPhaseInstances: 0, maximumAttempts: 0, maximumInvocations: 0,
    maximumBrokerRequests: 0, maximumEffects: 0, maximumTransitions: 0,
    maximumEvidenceRefs: 0, maximumEvidenceBytes: 0, maximumCheckpointBytes: 0,
    maximumTokens: 0, maximumTimeMs: 0, maximumCostMicros: 0,
  };
}

/**
 * Refuse a recipe that understates its own invocation envelope. `maxPhaseInvocations`
 * is the recipe's declared ceiling on host or provider invocations for one run, and
 * the compiled worst case — every phase instance, at every admitted attempt —
 * must fit inside it. Understating it is a recipe fault, not something to clamp.
 */
export function assertInvocationCeiling(recipe: PackRecipeV2, bounds: PreparationBoundsV1): void {
  if (bounds.maximumInvocations > recipe.bounds.maxPhaseInvocations) {
    throw new PackParseError("recipe maxPhaseInvocations is below its own compiled worst case");
  }
}
