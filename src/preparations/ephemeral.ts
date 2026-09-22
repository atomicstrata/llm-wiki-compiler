/**
 * @file src/preparations/ephemeral.ts
 * @description Ephemeral-read SHAPE eligibility (design sections 7.1, 10.4). This
 * module classifies whether a normalized preparation plan is ephemeral-read-shape
 * eligible: a plan that is read-only — it declares no durable gate, no mutating
 * external effect, no checkpoint, no bounded-repeat expansion, terminal-only
 * input retention, and no operation-bundle handoff. A read-only brokered call (an HTTPS or model fetch
 * that mutates nothing) is permitted and does NOT disqualify a plan, matching the
 * plan-graph ephemeral restrictions.
 *
 * This is a plan-SHAPE classification ONLY — it proves the plan is read-only in
 * form. It deliberately does NOT prove the plan is "executable now": binding a
 * Provider V2 invocation to the validated plan, deriving host-owned custody, and
 * running the provider live in {@link file://./ephemeral-execute.ts}, which calls
 * this classifier FIRST and refuses before any custody or launch. This module
 * never invokes anything.
 */

import { phaseDeclaresMutatingEffect } from "./plan-graph.js";
import type { NormalizedPhaseV1, NormalizedPreparationPlanV1 } from "./plan-types.js";

/** Typed refusal when a plan is not ephemeral-read-shape eligible. */
export class EphemeralIneligibleError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`plan is ineligible for ephemeral read: ${reason}`);
    this.name = "EphemeralIneligibleError";
    this.reason = reason;
  }
}

/** Return the first ephemeral-disqualifying property of one phase, else null. */
function phaseIneligibility(phase: NormalizedPhaseV1): string | null {
  if (phase.role === "gate" || phase.gate !== undefined) return "durable-gate-required";
  if (phase.expansion.kind === "bounded-repeat") return "durable-repeat-required";
  if (phaseDeclaresMutatingEffect(phase)) return "external-effect-required";
  if (phase.bounds.maximumCheckpointBytes > 0) return "checkpoint-required";
  return null;
}

/**
 * Return the first reason the plan is NOT ephemeral-read-shape eligible, or null
 * when it proves read-only in form: no durable gate, external effect, checkpoint,
 * bounded-repeat, non-terminal retention, or operation-bundle handoff. A read-only brokered call is
 * permitted and is not a disqualifier. This is a plan-SHAPE classification, not a
 * claim the plan is executable now — {@link file://./ephemeral-execute.ts} binds
 * the invocation and enforces the remaining execution-time authority.
 */
export function ephemeralIneligibility(plan: NormalizedPreparationPlanV1): string | null {
  if (plan.executionMode !== "ephemeral-read") return "execution-mode-not-ephemeral";
  if (plan.outputContract.handoffCapacity !== undefined) return "handoff-required";
  if (plan.initialInputSet.retention !== "terminal-only") return "durable-retention-required";
  if (plan.bounds.maximumEffects > 0) return "external-effect-required";
  if (plan.bounds.maximumCheckpointBytes > 0) return "checkpoint-required";
  for (const phase of plan.phases) {
    const reason = phaseIneligibility(phase);
    if (reason !== null) return reason;
  }
  return null;
}

/**
 * Assert the plan is ephemeral-read-shape eligible, throwing the typed refusal
 * otherwise. Shape eligibility only; execution binds further authority.
 */
export function assertEphemeralEligible(plan: NormalizedPreparationPlanV1): void {
  const reason = ephemeralIneligibility(plan);
  if (reason !== null) throw new EphemeralIneligibleError(reason);
}
