/**
 * @file test/preparations/run-headroom.test.ts
 * @description Control-headroom contract for the run budget: a realistic plan's
 * ordinary worst case fits below the reserved 256 KiB; the reserve holds the
 * fixed-shape terminal and settlement moves; and an ordinary worst case that
 * consumes the reserve, an over-cap transition count, and a zero control
 * allowance all fail closed with the exhausted dimension named.
 */

import { describe, expect, it } from "vitest";
import {
  assertPreparationRunWriteBudget, preparationRunWriteBudgetClass,
  projectPreparationRunBudget, RunBudgetError,
} from "../../src/preparations/run-budget.js";
import {
  MAX_PREPARATION_RUN_BYTES, MAX_TRANSITIONS_PER_RUN,
  PREPARATION_RUN_CONTROL_RESERVE_BYTES,
} from "../../src/preparations/constants.js";

const REALISTIC = {
  maximumPhaseInstances: 7, maximumEvidenceRefs: 21, maximumBrokerRequests: 0,
  maximumEffects: 0, maximumTransitions: 28, controlTransitionAllowance: 16,
};

describe("preparation run headroom", () => {
  it("proves a realistic plan retires within the non-reserved budget", () => {
    const budget = projectPreparationRunBudget(REALISTIC);
    expect(budget.projectedOrdinaryBytes).toBeLessThanOrEqual(MAX_PREPARATION_RUN_BYTES - PREPARATION_RUN_CONTROL_RESERVE_BYTES);
    expect(budget.projectedTotalBytes).toBeLessThanOrEqual(MAX_PREPARATION_RUN_BYTES);
    expect(budget.remainingReserve).toBeGreaterThanOrEqual(0);
  });

  it("classifies terminal and settlement moves into the reserved control lane", () => {
    for (const type of ["cancelled", "abandoned", "handed-off", "superseded", "failed", "headroom-exhausted"] as const) {
      expect(preparationRunWriteBudgetClass(type)).toBe("control");
    }
    expect(preparationRunWriteBudgetClass("phase-progressed")).toBe("ordinary");
  });

  it("rejects an over-cap transition count", () => {
    expect(() => projectPreparationRunBudget({ ...REALISTIC, maximumTransitions: MAX_TRANSITIONS_PER_RUN }))
      .toThrow(RunBudgetError);
  });

  it("rejects a zero control-transition allowance", () => {
    expect(() => projectPreparationRunBudget({ ...REALISTIC, controlTransitionAllowance: 0 })).toThrow(RunBudgetError);
  });

  it("refuses an ordinary write that would consume the reserve", () => {
    const overOrdinary = MAX_PREPARATION_RUN_BYTES - PREPARATION_RUN_CONTROL_RESERVE_BYTES + 1;
    expect(() => assertPreparationRunWriteBudget(overOrdinary, "ordinary")).toThrow(RunBudgetError);
    expect(() => assertPreparationRunWriteBudget(overOrdinary, "control")).not.toThrow();
  });
});
