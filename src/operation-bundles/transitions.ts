/**
 * @file src/operation-bundles/transitions.ts
 * @description Compute-only next-transition planner. It maps one logical
 * executor/recovery step to the exact AppendOperationTransitionInput plus the
 * expected OperationRunPredecessor, and NOTHING else: it never signs, validates,
 * budgets, or writes. All persistence routes through the existing Foundation
 * writers (appendOperationTransitionLocked / appendControlTransition /
 * appendRecoveredTransitionLocked / appendAbandonedTransitionLocked), which own
 * the single legal-edge/HMAC/budget authority.
 */

import type { CompensationId, MutationId } from "./ids.js";
import type { OperationPrincipal } from "./principal.js";
import type { OperationProblemCode } from "./problems.js";
import { operationRunPredecessor } from "./run-integrity.js";
import type {
  AppendOperationTransitionInput, OperationApplyOwner, OperationEvidenceReference,
  OperationRun, OperationRunPredecessor, OperationRunState, OperationTransitionPayload,
  OperationTransitionType, ProjectionCriticality,
} from "./run-types.js";
import type { OperationDigest } from "./types.js";

/** One authoritative or projection outcome the executor drives. */
export type EffectOutcomeStatus = "applied" | "skipped-idempotent" | "failed";

/** One logical step the executor or recovery coordinator asks to be recorded. */
export type OperationTransitionStep =
  | { kind: "approved"; authoritySnapshotDigest: OperationDigest }
  | { kind: "apply-started"; authoritySnapshotDigest: OperationDigest; applyOwner: OperationApplyOwner }
  | { kind: "recovery-resumed"; authoritySnapshotDigest: OperationDigest; applyOwner: OperationApplyOwner }
  | { kind: "approval-invalidated" }
  | { kind: "mutation-started"; mutationId: MutationId }
  | { kind: "mutation-outcome"; mutationId: MutationId; status: EffectOutcomeStatus; evidence?: OperationEvidenceReference; detail?: string }
  | { kind: "projection-started"; mutationId: MutationId; criticality: ProjectionCriticality }
  | { kind: "projection-outcome"; mutationId: MutationId; criticality: ProjectionCriticality; status: EffectOutcomeStatus; evidence?: OperationEvidenceReference }
  | { kind: "warning"; code: string; attempted: number; completed: number; skipped: number; failed: number }
  | { kind: "notice"; code: string }
  | { kind: "recovery-required"; code: OperationProblemCode }
  | { kind: "compensation-began"; authoritySnapshotDigest: OperationDigest; applyOwner: OperationApplyOwner }
  | { kind: "compensation-started"; compensationId: CompensationId; mutationId: MutationId }
  | { kind: "compensation-outcome"; compensationId: CompensationId; mutationId: MutationId; status: "completed" | "failed"; evidence: OperationEvidenceReference }
  | { kind: "compensated" }
  | { kind: "cancelled" }
  | { kind: "succeeded" }
  | { kind: "succeeded-with-warnings" };

/** One computed next transition and the exact predecessor it must extend. */
export interface PlannedTransition {
  input: AppendOperationTransitionInput;
  expected: OperationRunPredecessor;
}

interface TransitionShape {
  type: OperationTransitionType;
  stateAfter: OperationRunState;
  payload: OperationTransitionPayload;
}

/** Attach optional out-of-line evidence only when the step carries it. */
function withEvidence<T extends { kind: string }>(base: T, evidence?: OperationEvidenceReference): T & { evidence?: OperationEvidenceReference } {
  return evidence === undefined ? base : { ...base, evidence };
}

/** One builder per step kind, so the dispatch stays flat (cyclomatic 1). */
type StepBuilder<K extends OperationTransitionStep["kind"]> = (step: Extract<OperationTransitionStep, { kind: K }>) => TransitionShape;
type StepBuilders = { [K in OperationTransitionStep["kind"]]: StepBuilder<K> };

/** The exact closed (type, stateAfter, payload) tuple for each logical step. */
const STEP_BUILDERS: StepBuilders = {
  approved: (step) => ({ type: "approved", stateAfter: "approved", payload: { kind: "authority", authoritySnapshotDigest: step.authoritySnapshotDigest } }),
  "apply-started": (step) => ({ type: "apply-started", stateAfter: "applying", payload: { kind: "execution", authoritySnapshotDigest: step.authoritySnapshotDigest, applyOwner: step.applyOwner } }),
  "recovery-resumed": (step) => ({ type: "recovery-resumed", stateAfter: "applying", payload: { kind: "execution", authoritySnapshotDigest: step.authoritySnapshotDigest, applyOwner: step.applyOwner } }),
  "approval-invalidated": () => ({ type: "approval-invalidated", stateAfter: "approval-invalidated", payload: { kind: "problem", code: "approval-invalidated" } }),
  "mutation-started": (step) => ({ type: "mutation-started", stateAfter: "applying", payload: { kind: "mutation", mutationId: step.mutationId } }),
  "mutation-outcome": (step) => ({ type: `mutation-${step.status}`, stateAfter: "applying", payload: withEvidence(step.detail === undefined ? { kind: "mutation" as const, mutationId: step.mutationId } : { kind: "mutation" as const, mutationId: step.mutationId, detail: step.detail }, step.evidence) }),
  "projection-started": (step) => ({ type: "projection-started", stateAfter: "applying", payload: { kind: "projection", mutationId: step.mutationId, criticality: step.criticality } }),
  "projection-outcome": (step) => ({ type: `projection-${step.status}`, stateAfter: "applying", payload: withEvidence({ kind: "projection", mutationId: step.mutationId, criticality: step.criticality }, step.evidence) }),
  warning: (step) => ({ type: "warning-recorded", stateAfter: "applying", payload: { kind: "warning", code: step.code, attempted: step.attempted, completed: step.completed, skipped: step.skipped, failed: step.failed } }),
  notice: (step) => ({ type: "notice-recorded", stateAfter: "applying", payload: { kind: "notice", code: step.code } }),
  "recovery-required": (step) => ({ type: "recovery-required", stateAfter: "recovery-required", payload: { kind: "problem", code: step.code } }),
  "compensation-began": (step) => ({ type: "compensation-began", stateAfter: "compensating", payload: { kind: "execution", authoritySnapshotDigest: step.authoritySnapshotDigest, applyOwner: step.applyOwner } }),
  "compensation-started": (step) => ({ type: "compensation-started", stateAfter: "compensating", payload: { kind: "compensation", compensationId: step.compensationId, mutationId: step.mutationId } }),
  "compensation-outcome": (step) => ({ type: `compensation-${step.status}`, stateAfter: "compensating", payload: { kind: "compensation", compensationId: step.compensationId, mutationId: step.mutationId, evidence: step.evidence } }),
  compensated: () => ({ type: "compensated", stateAfter: "compensated", payload: { kind: "none" } }),
  cancelled: () => ({ type: "cancelled", stateAfter: "cancelled", payload: { kind: "none" } }),
  succeeded: () => ({ type: "succeeded", stateAfter: "succeeded", payload: { kind: "none" } }),
  "succeeded-with-warnings": () => ({ type: "succeeded-with-warnings", stateAfter: "succeeded-with-warnings", payload: { kind: "none" } }),
};

/** Map one step to its exact closed (type, stateAfter, payload) tuple. */
function stepToTransition(step: OperationTransitionStep): TransitionShape {
  return (STEP_BUILDERS[step.kind] as StepBuilder<OperationTransitionStep["kind"]>)(step);
}

/**
 * Compute the next transition input and the predecessor it must extend from the
 * CURRENT run. The caller transitions the staging-created run in place; it never
 * fabricates a progressed record.
 */
export function computeTransition(
  run: OperationRun,
  actor: OperationPrincipal,
  at: string,
  step: OperationTransitionStep,
): PlannedTransition {
  const shape = stepToTransition(step);
  return {
    input: { type: shape.type, stateAfter: shape.stateAfter, payload: shape.payload, actor, at },
    expected: operationRunPredecessor(run),
  };
}
