/**
 * @file test/operation-bundles/run-budget.test.ts
 * @description Exact transition-count, ordinary-byte, and reserved-control
 * headroom tests for operation-run staging and runtime replacement.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_RUN_BYTES,
  MAX_RUN_TRANSITIONS,
  MAX_TRANSITION_ENVELOPE_BYTES,
  RUN_CONTROL_RESERVE_BYTES,
} from "../../src/operation-bundles/constants.js";
import {
  assertOperationRunWriteBudget,
  operationRunWriteBudgetClass,
  projectRunBudget,
  RunBudgetError,
} from "../../src/operation-bundles/run-budget.js";
import { OPERATION_TRANSITION_TYPES, type OperationTransitionType } from "../../src/operation-bundles/run-types.js";

const CONTROL_TYPES: readonly OperationTransitionType[] = [
  "recovery-required", "recovery-resumed", "compensation-began",
  "succeeded", "succeeded-with-warnings", "rejected", "superseded",
  "approval-invalidated", "cancelled", "compensated", "failed", "recovered", "abandoned",
];

describe("operation run budget", () => {
  it("charges genesis, approval, and apply framing even when no work is declared", () => {
    const budget = projectRunBudget({ mutationCount: 0, declaredCompensatorCount: 0, projectionCount: 0, controlTransitionAllowance: 0 });
    expect(budget.projectedTransitionCount).toBe(3);
    expect(budget.projectedOrdinaryBytes).toBeGreaterThan(64);
    expect(budget.projectedTotalBytes).toBe(budget.projectedOrdinaryBytes);
  });

  it("computes canonical whole-record bytes including genesis and control framing", () => {
    const budget = projectRunBudget({
      mutationCount: 3, declaredCompensatorCount: 2,
      projectionCount: 1, controlTransitionAllowance: 4,
    });
    expect(budget.projectedTransitionCount).toBe(26);
    expect(budget.projectedOrdinaryBytes).toBeGreaterThan(0);
    expect(budget.projectedTotalBytes).toBeGreaterThan(budget.projectedOrdinaryBytes);
    expect(budget.remainingReserve).toBe(RUN_CONTROL_RESERVE_BYTES - (budget.projectedTotalBytes - budget.projectedOrdinaryBytes));
  });

  it("budgets every accepted transition at the full envelope cap", () => {
    const allowance = 4;
    const budget = projectRunBudget({
      mutationCount: 3, declaredCompensatorCount: 2,
      projectionCount: 1, controlTransitionAllowance: allowance,
    });
    const ordinaryCount = budget.projectedTransitionCount - allowance;
    expect(budget.projectedOrdinaryBytes).toBeGreaterThanOrEqual(
      ordinaryCount * MAX_TRANSITION_ENVELOPE_BYTES,
    );
    expect(budget.projectedTotalBytes).toBeGreaterThanOrEqual(
      budget.projectedTransitionCount * MAX_TRANSITION_ENVELOPE_BYTES,
    );
  });

  it("charges maximum digit width for every completion-warning count", () => {
    const budget = projectRunBudget({
      mutationCount: 0, declaredCompensatorCount: 0,
      projectionCount: 1, controlTransitionAllowance: 1,
    });
    expect(budget.projectedOrdinaryBytes).toBe(18_070);
    expect(budget.projectedTotalBytes).toBe(20_119);
  });

  it("charges maximum approval churn and notices in the same envelope", () => {
    const budget = projectRunBudget({
      mutationCount: 0, declaredCompensatorCount: 0,
      projectionCount: 0, controlTransitionAllowance: 4,
    });
    expect(budget.projectedTransitionCount).toBe(13);
  });

  it("fits 256 mutations and compensators only while the complete count fits", () => {
    const atEnvelope = projectRunBudget({
      mutationCount: 256, declaredCompensatorCount: 256,
      projectionCount: 0, controlTransitionAllowance: 16,
    });
    expect(atEnvelope.projectedTransitionCount).toBe(1_073);
    expect(atEnvelope.projectedTransitionCount).toBeLessThanOrEqual(MAX_RUN_TRANSITIONS);
    expect(() => projectRunBudget({
      mutationCount: 256, declaredCompensatorCount: 256,
      projectionCount: 22, controlTransitionAllowance: 16,
    })).toThrow(RunBudgetError);
  });

  it("rejects more control transitions than the exact 128 KiB reserve holds", () => {
    expect(() => projectRunBudget({
      mutationCount: 0, declaredCompensatorCount: 0,
      projectionCount: 0, controlTransitionAllowance: 200,
    })).toThrow(/control reserve/);
  });

  it("rejects more than 1,100 projected transitions", () => {
    expect(() => projectRunBudget({
      mutationCount: 256, declaredCompensatorCount: 256,
      projectionCount: 0, controlTransitionAllowance: 37,
    })).toThrow(/1,100/);
  });

  it("rejects an ordinary write that consumes one byte of control reserve", () => {
    const ordinaryLimit = MAX_RUN_BYTES - RUN_CONTROL_RESERVE_BYTES;
    expect(() => assertOperationRunWriteBudget(ordinaryLimit, "ordinary")).not.toThrow();
    expect(() => assertOperationRunWriteBudget(ordinaryLimit + 1, "ordinary")).toThrow(/reserved control headroom/);
  });

  it("allows fixed-shape control writes through the record boundary only", () => {
    expect(() => assertOperationRunWriteBudget(MAX_RUN_BYTES, "control")).not.toThrow();
    expect(() => assertOperationRunWriteBudget(MAX_RUN_BYTES + 1, "control")).toThrow(/4 MiB/);
  });

  it("derives the reserved lane for every park, recovery, and terminal control class", () => {
    const control = new Set<OperationTransitionType>(CONTROL_TYPES);
    for (const type of OPERATION_TRANSITION_TYPES) {
      const lane = operationRunWriteBudgetClass(type);
      expect(lane).toBe(control.has(type) ? "control" : "ordinary");
      const boundary = lane === "control" ? MAX_RUN_BYTES : MAX_RUN_BYTES - RUN_CONTROL_RESERVE_BYTES;
      expect(() => assertOperationRunWriteBudget(boundary, lane)).not.toThrow();
      expect(() => assertOperationRunWriteBudget(boundary + 1, lane)).toThrow();
    }
  });

  it("rejects negative, fractional, and unsafe budget inputs", () => {
    const invalid = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1];
    for (const mutationCount of invalid) {
      expect(() => projectRunBudget({ mutationCount, declaredCompensatorCount: 0, projectionCount: 0, controlTransitionAllowance: 0 })).toThrow(RunBudgetError);
    }
  });
});
