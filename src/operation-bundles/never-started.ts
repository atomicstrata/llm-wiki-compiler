/** @file Shared conservative proof of a never-started operation. Observation
 * and retirement use the same complete-chain predicate, not absence of one
 * event name. False is uncertainty, not proof that a mutation occurred. */
import type { OperationRun } from "./run-types.js";

/** Require exclusively pre-effect history, without owners, outcomes or residuals. */
export function operationNeverStarted(run: OperationRun): boolean {
  const allowed = ["run-staged", "approved", "approval-invalidated", "notice-recorded", "warning-recorded", "superseded"];
  return !run.applyOwner && run.mutationOutcomes.length === 0 && run.projectionOutcomes.length === 0 &&
    run.compensationOutcomes.length === 0 && run.residualFindings.length === 0 &&
    run.transitions.every(event => allowed.includes(event.type));
}
