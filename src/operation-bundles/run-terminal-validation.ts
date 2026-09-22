/**
 * @file src/operation-bundles/run-terminal-validation.ts
 * @description State-specific terminal-proof validation for HMAC-protected
 * operation runs after their transition and outcome projections are replayed.
 */

import type {
  OperationRunContent, OperationRunState, OperationTransitionType,
  ProjectionCriticality, RunCompletionWarning,
} from "./run-types.js";
import { unresolvedResidualIds } from "./run-residuals.js";

type WarningCountField = keyof Omit<RunCompletionWarning, "code">;

/** Stable counter order used for warning chronology comparisons. */
const WARNING_COUNT_FIELDS = ["attempted", "completed", "skipped", "failed"] as const satisfies readonly WarningCountField[];

/** Optional projection terminal edges and the warning counter they settle. */
const OPTIONAL_TERMINAL_FIELDS: Partial<Record<OperationTransitionType, Exclude<WarningCountField, "attempted">>> = {
  "projection-applied": "completed",
  "projection-skipped-idempotent": "skipped",
  "projection-failed": "failed",
};

/** Require state-specific, evidence-backed terminal settlement. */
export function validateOperationRunTerminalProof(run: OperationRunContent): void {
  if (run.applyOwner !== undefined && terminal(run.state)) throw new Error("terminal run retains applyOwner");
  validateWarningChronology(run);
  TERMINAL_VALIDATORS[run.state]?.(run);
}

const TERMINAL_VALIDATORS: Partial<Record<OperationRunState, (run: OperationRunContent) => void>> = {
  succeeded: validateSuccess, "succeeded-with-warnings": validateSuccess,
  compensated: validateCompensated, recovered: validateRecovered,
  abandoned: validateAbandoned, failed: validateNoEffectTerminal,
  cancelled: validateNoEffectTerminal,
};

/** Require every success obligation and warning distinction to be settled. */
function validateSuccess(run: OperationRunContent): void {
  const required = projectionStats(run, "required"), optional = projectionStats(run, "optional");
  assertSuccessfulMutations(run);
  if (required.settled !== required.declared) throw new Error("required work is unresolved at terminal success");
  const reversed = run.transitions.some((transition) => transition.type === "compensation-began");
  if (reversed || run.compensationOutcomes.length > 0) throw new Error("success cannot follow compensation-began or a compensation outcome");
  if (run.residualFindings.length > 0) throw new Error("required work is unresolved at terminal success");
  validateOptionalSuccess(run, optional);
}

/** Require one settled outcome for every authoritative mutation. */
function assertSuccessfulMutations(run: OperationRunContent): void {
  if (run.mutationOutcomes.length !== run.obligations.authoritativeMutationIds.length) throw new Error("required work is unresolved at terminal success");
  if (run.mutationOutcomes.some((item) => !settled(item.status))) throw new Error("required work is unresolved at terminal success");
}

/** Distinguish complete success from reconciled optional incompleteness. */
function validateOptionalSuccess(run: OperationRunContent, optional: ReturnType<typeof projectionStats>): void {
  if (run.state === "succeeded" && (optional.settled !== optional.declared || run.completionWarnings.length > 0)) {
    throw new Error("optional work or warnings contradict succeeded state");
  }
  if (run.state === "succeeded-with-warnings") validateWarningCounts(run.completionWarnings, optional);
}

/** Summarize declared and current outcomes for one projection class. */
function projectionStats(run: OperationRunContent, criticality: ProjectionCriticality) {
  const declared = run.obligations.projections.filter((item) => item.criticality === criticality).length;
  const outcomes = run.projectionOutcomes.filter((item) => item.criticality === criticality);
  return {
    declared, attempted: outcomes.length, completed: outcomes.filter((item) => item.status === "applied").length,
    skipped: outcomes.filter((item) => item.status === "skipped-idempotent").length,
    failed: outcomes.filter((item) => item.status === "failed").length,
    settled: outcomes.filter((item) => settled(item.status)).length,
  };
}

/** Reconcile all warning counters with optional projection outcomes. */
function validateWarningCounts(warnings: readonly RunCompletionWarning[], optional: ReturnType<typeof projectionStats>): void {
  const totals = warningTotals(warnings);
  if (warnings.length === 0 || optional.failed === 0 || optional.attempted !== optional.declared
    || totals.attempted !== optional.attempted || totals.completed !== optional.completed
    || totals.skipped !== optional.skipped || totals.failed !== optional.failed) {
    throw new Error("completion warning counts do not reconcile optional outcomes");
  }
}

/** Reconcile cumulative warning claims with prior optional terminal outcomes. */
function validateWarningChronology(run: OperationRunContent): void {
  const actual = { attempted: 0, completed: 0, skipped: 0, failed: 0 };
  const claimed = { attempted: 0, completed: 0, skipped: 0, failed: 0 };
  for (const transition of run.transitions) {
    const payload = transition.payload;
    const settledField = payload.kind === "projection" && payload.criticality === "optional"
      ? OPTIONAL_TERMINAL_FIELDS[transition.type] : undefined;
    if (settledField !== undefined) {
      actual[settledField] += 1;
      actual.attempted += 1;
    }
    if (payload.kind !== "warning") continue;
    for (const field of WARNING_COUNT_FIELDS) claimed[field] += payload[field];
    if (WARNING_COUNT_FIELDS.some((field) => claimed[field] > actual[field])) {
      throw new Error("completion warning counts do not reconcile optional outcomes at warning sequence");
    }
  }
}

/** Sum bounded warning counters without assigning them new semantics. */
function warningTotals(warnings: readonly RunCompletionWarning[]) {
  const sum = (field: keyof Omit<RunCompletionWarning, "code">) =>
    warnings.reduce((total, item) => total + item[field], 0);
  return { attempted: sum("attempted"), completed: sum("completed"), skipped: sum("skipped"), failed: sum("failed") };
}

/** Require evidence-backed neutralization of every applied authoritative effect. */
function validateCompensated(run: OperationRunContent): void {
  assertCompensatedOutcomeShape(run);
  const applied = run.mutationOutcomes.filter((item) => item.status === "applied").map((item) => item.mutationId);
  if (applied.length === 0 || run.compensationOutcomes.length !== applied.length) throw new Error("compensated run has unresolved applied effects");
  for (const mutation of applied) assertCompletedCompensation(run, mutation);
}

/** Reject uncertainty or live projections from a compensated terminal. */
function assertCompensatedOutcomeShape(run: OperationRunContent): void {
  if (run.mutationOutcomes.some((item) => item.status === "started")) {
    throw new Error("compensated run retains an uncertain mutation");
  }
  if (run.projectionOutcomes.some((item) => item.status === "started" || item.status === "applied")) {
    throw new Error("compensated run cannot neutralize a started or applied projection");
  }
}

/** Require one declared, completed, evidence-bearing compensation. */
function assertCompletedCompensation(run: OperationRunContent, mutation: string): void {
  const obligation = run.obligations.compensations.find((item) => item.mutationId === mutation);
  const outcome = run.compensationOutcomes.find((item) => item.mutationId === mutation);
  if (obligation === undefined || outcome?.status !== "completed" || !completedCompensationHasEvidence(run, outcome.transitionSequence)) {
    throw new Error("compensated run requires completed compensation evidence for every applied effect");
  }
}

/** Check that a completed outcome points at an evidence-bearing transition. */
function completedCompensationHasEvidence(run: OperationRunContent, sequence: number): boolean {
  const payload = run.transitions[sequence]?.payload;
  return payload?.kind === "compensation" && payload.evidence !== undefined;
}

/** Require an embedded proof naming a distinct recovery bundle and run. */
function validateRecovered(run: OperationRunContent): void {
  const transition = run.transitions.at(-1)!;
  if (transition.payload.kind !== "recovery" || transition.payload.bundleId === run.bundleId || transition.payload.runId === run.runId) {
    throw new Error("recovered run requires a distinct successful bound recovery bundle");
  }
}

/** Require granted, identity-bound, evidence-backed residual findings. */
function validateAbandoned(run: OperationRunContent): void {
  assertAbandonmentGrant(run);
  const allowed = new Set([...run.obligations.authoritativeMutationIds, ...run.obligations.projections.map((item) => item.mutationId)]);
  assertResidualFindingShapes(run, allowed);
  assertCompleteResidualCoverage(run);
}

/** Require a confirmed, granted abandonment transition. */
function assertAbandonmentGrant(run: OperationRunContent): void {
  const transition = run.transitions.at(-1)!;
  if (transition.payload.kind !== "abandonment" || !transition.actor.grants.includes("operation-bundle.abandon")) {
    throw new Error("abandoned run requires destructive confirmation and residual findings");
  }
}

/** Validate unique, manifest-owned, evidence-bearing residual findings. */
function assertResidualFindingShapes(run: OperationRunContent, allowed: ReadonlySet<string>): void {
  const actual = run.residualFindings.map((finding) => finding.mutationId);
  if (new Set(actual).size !== actual.length) throw new Error("abandoned residual findings contain duplicate coverage");
  for (const finding of run.residualFindings) {
    if (finding.mutationId === undefined || !allowed.has(finding.mutationId) || finding.authoritativeNamespace === undefined || finding.evidence === undefined) {
      throw new Error("abandoned residual finding lacks unresolved identity, namespace, or evidence");
    }
  }
}

/** Require exact finding coverage of every potentially live work identity. */
function assertCompleteResidualCoverage(run: OperationRunContent): void {
  const actual = run.residualFindings.map((finding) => finding.mutationId!);
  const expected = unresolvedResidualIds(run);
  if (actual.length !== expected.length || expected.some((id) => !actual.includes(id))) {
    throw new Error("abandoned residual findings do not completely cover unresolved work");
  }
}

/** Prevent failed or cancelled pre-effect terminals from claiming live work. */
function validateNoEffectTerminal(run: OperationRunContent): void {
  if (run.mutationOutcomes.length + run.projectionOutcomes.length + run.compensationOutcomes.length > 0
    || run.completionWarnings.length + run.notices.length + run.residualFindings.length > 0) {
    throw new Error(`${run.state} terminal cannot claim live-effect settlement`);
  }
}

/** True for every irreversible terminal run state. */
function terminal(state: OperationRunState): boolean {
  return ["succeeded", "succeeded-with-warnings", "rejected", "superseded", "cancelled", "compensated", "failed", "recovered", "abandoned"].includes(state);
}

/** True for authoritative or projection outcomes with no unresolved work. */
function settled(status: string): boolean { return status === "applied" || status === "skipped-idempotent"; }
