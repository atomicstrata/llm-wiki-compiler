/**
 * @file src/preparations/plan-bounds.ts
 * @description Worst-case envelope arithmetic for a normalized preparation plan
 * (design sections 10.4, 26.1, and PO-INV-10). The complete graph, expansion,
 * attempt, call, effect, transition, evidence, byte, token, time, and cost
 * envelope is computed BEFORE any durable work. A plan is never clamped to a
 * ceiling: an over-ceiling worst case, an understated declared bound, or an
 * unsafe intermediate all fail closed with the exact exhausted dimension. The
 * handoff subset is checked against the pinned Milestone A caps.
 */

import {
  MAX_ATTEMPTS_PER_PHASE_INSTANCE, MAX_CHECKPOINT_BYTES_PER_RUN,
  MAX_EVIDENCE_REFS_PER_RUN, MAX_HANDOFF_ACTIVE_STORE_BYTES,
  MAX_HANDOFF_AGGREGATE_PAYLOAD_BYTES, MAX_HANDOFF_ITEM_PAYLOAD_BYTES,
  MAX_HANDOFF_MANIFEST_BYTES, MAX_HANDOFF_RUN_EVIDENCE_BYTES,
  MAX_HANDOFF_RUN_EVIDENCE_ITEM_BYTES, MAX_INVOCATIONS_PER_RUN,
  MAX_PHASE_INSTANCES_PER_RUN, MAX_RETAINED_EVIDENCE_BYTES,
  MAX_TRANSITIONS_PER_RUN,
} from "./constants.js";
import { PreparationBoundsError } from "./problems.js";
import type {
  HandoffCapacityPlanV1, NormalizedPhaseV1, NormalizedPreparationPlanV1,
  PreparationBoundsV1,
} from "./plan-types.js";

/** The complete worst-case run envelope computed from the plan graph. */
export interface PreparationWorstCaseEnvelope {
  phaseInstances: number;
  attempts: number;
  invocations: number;
  brokerRequests: number;
  effects: number;
  transitions: number;
  evidenceRefs: number;
  evidenceBytes: number;
  checkpointBytes: number;
  tokens: number;
  timeMs: number;
  costMicros: number;
}

const ATTEMPTS_CEILING = MAX_PHASE_INSTANCES_PER_RUN * MAX_ATTEMPTS_PER_PHASE_INSTANCE;

/** Multiply two nonnegative counts, failing closed on an unsafe intermediate. */
function safeMul(a: number, b: number, dimension: string): number {
  const result = a * b;
  if (!Number.isSafeInteger(result)) throw new PreparationBoundsError(`${dimension}-arithmetic`);
  return result;
}

/** Add two nonnegative counts, failing closed on an unsafe intermediate. */
function safeAdd(a: number, b: number, dimension: string): number {
  const result = a + b;
  if (!Number.isSafeInteger(result)) throw new PreparationBoundsError(`${dimension}-arithmetic`);
  return result;
}

/** The worst-case materialized instance count for one phase's expansion policy. */
function phaseInstanceCount(phase: NormalizedPhaseV1): number {
  if (phase.expansion.kind === "map") return phase.expansion.maximumItems;
  if (phase.expansion.kind === "bounded-repeat") return phase.expansion.maximumIterations;
  return 1;
}

/** Fold one phase's worst-case contribution into the running envelope. */
function addPhase(env: PreparationWorstCaseEnvelope, phase: NormalizedPhaseV1): PreparationWorstCaseEnvelope {
  const instances = phaseInstanceCount(phase);
  const b = phase.bounds;
  const attempts = safeMul(instances, b.maximumAttempts, "attempts");
  return {
    phaseInstances: safeAdd(env.phaseInstances, instances, "phase-instances"),
    attempts: safeAdd(env.attempts, attempts, "attempts"),
    invocations: safeAdd(env.invocations, safeMul(attempts, b.maximumInvocationsPerAttempt, "invocations"), "invocations"),
    brokerRequests: safeAdd(env.brokerRequests, safeMul(attempts, b.maximumBrokerRequestsPerAttempt, "broker-requests"), "broker-requests"),
    effects: safeAdd(env.effects, safeMul(attempts, b.maximumEffectsPerAttempt, "effects"), "effects"),
    transitions: safeAdd(env.transitions, safeMul(instances, b.maximumTransitionsPerInstance, "transitions"), "transitions"),
    evidenceRefs: safeAdd(env.evidenceRefs, safeAdd(attempts, instances, "evidence-refs"), "evidence-refs"),
    evidenceBytes: safeAdd(env.evidenceBytes, safeMul(instances, b.maximumOutputEvidenceBytes, "evidence-bytes"), "evidence-bytes"),
    checkpointBytes: safeAdd(env.checkpointBytes, safeMul(instances, b.maximumCheckpointBytes, "checkpoint-bytes"), "checkpoint-bytes"),
    tokens: safeAdd(env.tokens, safeMul(attempts, b.maximumTokensPerAttempt, "tokens"), "tokens"),
    timeMs: safeAdd(env.timeMs, safeMul(instances, b.maximumTimeMsPerInstance, "time-ms"), "time-ms"),
    costMicros: safeAdd(env.costMicros, safeMul(attempts, b.maximumCostMicrosPerAttempt, "cost-micros"), "cost-micros"),
  };
}

/** Compute the plan's complete worst-case envelope from graph and expansions. */
export function computePreparationWorstCase(plan: NormalizedPreparationPlanV1): PreparationWorstCaseEnvelope {
  const zero: PreparationWorstCaseEnvelope = {
    phaseInstances: 0, attempts: 0, invocations: 0, brokerRequests: 0, effects: 0,
    transitions: 0, evidenceRefs: 0, evidenceBytes: 0, checkpointBytes: 0, tokens: 0, timeMs: 0, costMicros: 0,
  };
  return withMaterializationReservation(plan.phases.reduce(addPhase, zero), plan);
}

/**
 * Reserve the runner's finalization overhead in the stage-time envelope
 * (runner design v3 §6): exactly one materialization-manifest evidence ref plus
 * the declared payload refs, and the declared manifest plus payload bytes.
 *
 * Applied ONLY when the plan declares all three materialization limits. A plan
 * declaring none keeps its previous envelope byte-identically, and a PARTIAL
 * declaration contributes no reservation — it is a refusal state the runner
 * enforces at entry, not an accounting state; charging half a declaration
 * would let an incomplete contract look funded. Without this reservation a
 * plan admitted exactly at `maximumEvidenceRefs`/`maximumEvidenceBytes` could
 * complete every phase and then be unable to finalize — a guard that strands.
 */
function withMaterializationReservation(
  env: PreparationWorstCaseEnvelope, plan: NormalizedPreparationPlanV1,
): PreparationWorstCaseEnvelope {
  const capacity = plan.outputContract.handoffCapacity;
  if (capacity === undefined) return env;
  const manifestBytes = capacity.maximumMaterializationManifestBytes;
  const payloadRefs = capacity.maximumMaterializationPayloadRefs;
  const payloadBytes = capacity.maximumMaterializationPayloadBytes;
  if (manifestBytes === undefined || payloadRefs === undefined || payloadBytes === undefined) return env;
  return {
    ...env,
    evidenceRefs: safeAdd(env.evidenceRefs, safeAdd(1, payloadRefs, "evidence-refs"), "evidence-refs"),
    evidenceBytes: safeAdd(env.evidenceBytes, safeAdd(manifestBytes, payloadBytes, "evidence-bytes"), "evidence-bytes"),
  };
}

/** One dimension's computed worst case, declared bound, optional ceiling, name. */
type BoundCheck = readonly [number, number, number | undefined, string];

/** Enumerate every dimension check tying a computed value to its declared bound. */
function boundChecks(declared: PreparationBoundsV1, env: PreparationWorstCaseEnvelope): BoundCheck[] {
  return [
    [env.phaseInstances, declared.maximumPhaseInstances, MAX_PHASE_INSTANCES_PER_RUN, "phase-instances"],
    [env.attempts, declared.maximumAttempts, ATTEMPTS_CEILING, "attempts"],
    [env.invocations, declared.maximumInvocations, MAX_INVOCATIONS_PER_RUN, "invocations"],
    [env.brokerRequests, declared.maximumBrokerRequests, undefined, "broker-requests"],
    [env.effects, declared.maximumEffects, undefined, "effects"],
    [env.transitions, declared.maximumTransitions, MAX_TRANSITIONS_PER_RUN, "transitions"],
    [env.evidenceRefs, declared.maximumEvidenceRefs, MAX_EVIDENCE_REFS_PER_RUN, "evidence-refs"],
    [env.evidenceBytes, declared.maximumEvidenceBytes, MAX_RETAINED_EVIDENCE_BYTES, "evidence-bytes"],
    [env.checkpointBytes, declared.maximumCheckpointBytes, MAX_CHECKPOINT_BYTES_PER_RUN, "checkpoint-bytes"],
    [env.tokens, declared.maximumTokens, undefined, "tokens"],
    [env.timeMs, declared.maximumTimeMs, undefined, "time-ms"],
    [env.costMicros, declared.maximumCostMicros, undefined, "cost-micros"],
  ];
}

/** Enforce one dimension: never clamp, reject over-ceiling or understated bounds. */
function applyBoundCheck([computed, declared, ceiling, dimension]: BoundCheck): void {
  if (ceiling !== undefined && computed > ceiling) throw new PreparationBoundsError(dimension);
  if (declared < computed) throw new PreparationBoundsError(dimension);
  if (ceiling !== undefined && declared > ceiling) throw new PreparationBoundsError(dimension);
}

/** Compute and enforce the full worst-case envelope and the handoff subset. */
export function assertPreparationBounds(plan: NormalizedPreparationPlanV1): PreparationWorstCaseEnvelope {
  const env = computePreparationWorstCase(plan);
  for (const check of boundChecks(plan.bounds, env)) applyBoundCheck(check);
  if (plan.outputContract.handoffCapacity !== undefined) {
    assertHandoffCapacity(plan.outputContract.handoffCapacity);
  }
  return env;
}

/** One handoff field, its exact pinned Milestone A cap, and its dimension name. */
type HandoffCheck = readonly [number, number, string];

/**
 * Enforce the handoff subset against the pinned Milestone A V2 caps AND the
 * exact downstream envelope (design section 10.4). Per-field ceilings are
 * necessary but not sufficient: the plan's own class budgets must be internally
 * consistent (an aggregate cannot exceed its item-count budget) and their sum
 * cannot exceed the declared bundle payload, or three 64 MiB-capped classes
 * would silently admit 192 MiB of evidence. The envelope is summed with
 * fail-closed arithmetic; an over-envelope plan is rejected, never clamped.
 */
function assertHandoffCapacity(capacity: HandoffCapacityPlanV1): void {
  let aggregateEnvelopeBytes = 0;
  for (const klass of capacity.includedEvidenceClasses) {
    assertHandoffClass(klass);
    aggregateEnvelopeBytes = safeAdd(aggregateEnvelopeBytes, klass.maximumAggregateBytes, "handoff-aggregate-envelope");
  }
  if (aggregateEnvelopeBytes > capacity.maximumBundlePayloadBytes) {
    throw new PreparationBoundsError("handoff-aggregate-envelope");
  }
  const checks: HandoffCheck[] = [
    [capacity.maximumBundlePayloadBytes, MAX_HANDOFF_AGGREGATE_PAYLOAD_BYTES, "handoff-aggregate-payload"],
    [capacity.maximumManifestBytes, MAX_HANDOFF_MANIFEST_BYTES, "handoff-manifest"],
    [capacity.maximumRunEvidenceItemBytes, MAX_HANDOFF_RUN_EVIDENCE_ITEM_BYTES, "handoff-run-evidence-item"],
    [capacity.maximumRunEvidenceBytes, MAX_HANDOFF_RUN_EVIDENCE_BYTES, "handoff-run-evidence"],
    [capacity.maximumActiveStoreContributionBytes, MAX_HANDOFF_ACTIVE_STORE_BYTES, "handoff-active-store"],
  ];
  for (const check of checks) applyHandoffCheck(check);
}

/** Enforce one evidence class's internal budget and pinned per-item/aggregate caps. */
function assertHandoffClass(klass: HandoffCapacityPlanV1["includedEvidenceClasses"][number]): void {
  if (klass.maximumItemBytes > klass.maximumAggregateBytes) {
    throw new PreparationBoundsError("handoff-class-consistency");
  }
  if (klass.maximumAggregateBytes > safeMul(klass.maximumItems, klass.maximumItemBytes, "handoff-class-envelope")) {
    throw new PreparationBoundsError("handoff-class-envelope");
  }
  applyHandoffCheck([klass.maximumItemBytes, MAX_HANDOFF_ITEM_PAYLOAD_BYTES, "handoff-item-payload"]);
  applyHandoffCheck([klass.maximumAggregateBytes, MAX_HANDOFF_AGGREGATE_PAYLOAD_BYTES, "handoff-aggregate-payload"]);
}

/** Reject one handoff dimension that exceeds its pinned Milestone A cap. */
function applyHandoffCheck([value, ceiling, dimension]: HandoffCheck): void {
  if (value > ceiling) throw new PreparationBoundsError(dimension);
}
