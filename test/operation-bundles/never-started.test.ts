/** @file Conservative predicate witnesses using synthetic inputs, not a claim
 * that partial or future histories are currently reachable authenticated runs. */
import { expect, it } from "vitest";
import { operationNeverStarted } from "../../src/operation-bundles/never-started.js";
import type { OperationRun } from "../../src/operation-bundles/run-types.js";

/** Minimal predicate input, not a stored-run fixture. */
function sample(type = "run-staged"): OperationRun {
  return { transitions: [{ type }], mutationOutcomes: [], projectionOutcomes: [], compensationOutcomes: [],
    residualFindings: [] } as unknown as OperationRun;
}

it("admits only explicitly pre-effect transitions", () => {
  for (const type of ["run-staged", "approved", "approval-invalidated", "notice-recorded", "warning-recorded", "superseded"]) {
    expect(operationNeverStarted(sample(type))).toBe(true);
  }
  for (const type of ["apply-started", "mutation-started", "projection-started", "compensation-started",
    "compensation-began", "compensated", "recovered", "recovery-required", "recovery-resumed",
    "succeeded", "succeeded-with-warnings", "cancelled", "abandoned", "future-event"]) {
    expect(operationNeverStarted(sample(type))).toBe(false);
  }
});

it("owners and outcome evidence defeat never-startedness independently of event names", () => {
  for (const key of ["mutationOutcomes", "projectionOutcomes", "compensationOutcomes", "residualFindings"]) {
    expect(operationNeverStarted({ ...sample(), [key]: [{}] })).toBe(false);
  }
  expect(operationNeverStarted({ ...sample(), applyOwner: {} } as OperationRun)).toBe(false);
});
