/**
 * @file test/preparation-capacity-matrix-ceilings.test.ts
 * @description Exact cap-boundary coverage for the run-budget dimensions that
 * are enforced but NOT reachable through the CLI: the two launch ceilings
 * `projectPreparationRunBudget` re-checks (`src/preparations/run-budget.ts:139`
 * and `:140`), the whole-run transition cap (`:81`), the 4 MiB record cap, and
 * the two write lanes of `assertPreparationRunWriteBudget` (`:154-160`).
 *
 * TWO SHADOWED CAPS are recorded here as findings rather than smoothed over.
 * `MAX_TRANSITIONS_PER_RUN` and `MAX_EVIDENCE_REFS_PER_RUN` have no admissible
 * at-cap case at all: a record sitting exactly on either is already past the
 * non-reserved byte budget, so the refusal that arrives names the byte lane, not
 * the dimension. Writing an at-cap test that "passes" for those two would mean
 * testing a number the system can never accept; what is pinned instead is which
 * refusal actually binds, so a future change that reorders them goes red.
 */

import { describe, expect, it } from "vitest";
import {
  assertPreparationRunWriteBudget, projectPreparationRunBudget, RunBudgetError,
} from "../src/preparations/run-budget.js";
import {
  MAX_EVIDENCE_REFS_PER_RUN, MAX_PHASE_INSTANCES_PER_RUN, MAX_PREPARATION_RUN_BYTES,
  MAX_TRANSITIONS_PER_RUN, PREPARATION_RUN_CONTROL_RESERVE_BYTES,
} from "../src/preparations/constants.js";
import { budgetInputFor, planFor, DEFAULT_SEED } from "./preparation-capacity-fixture.js";
import type { RunBudgetInput } from "../src/preparations/run-budget.js";

/** The allowance every case here pins, well inside the reserve. */
const ALLOWANCE = 16;

/** The base budget shape, taken from the same plan the CLI cases stage. */
function shape(overrides: Partial<RunBudgetInput> = {}): RunBudgetInput {
  return { ...budgetInputFor(planFor(DEFAULT_SEED), ALLOWANCE), ...overrides };
}

/** Project one budget and return whatever it threw, or null. */
function projectionError(input: RunBudgetInput): unknown {
  try {
    projectPreparationRunBudget(input);
  } catch (error) {
    return error;
  }
  return null;
}

describe("phase-instance launch ceiling", () => {
  it("projects a budget at exactly MAX_PHASE_INSTANCES_PER_RUN", () => {
    expect(projectionError(shape({ maximumPhaseInstances: MAX_PHASE_INSTANCES_PER_RUN }))).toBeNull();
  });

  it("refuses one phase instance over the ceiling", () => {
    const caught = projectionError(shape({ maximumPhaseInstances: MAX_PHASE_INSTANCES_PER_RUN + 1 }));

    expect(caught).toBeInstanceOf(RunBudgetError);
    expect((caught as Error).message).toBe("maximum phase instances exceed the launch ceiling");
  });
});

describe("evidence-ref launch ceiling", () => {
  it("refuses one evidence ref over the ceiling", () => {
    const caught = projectionError(shape({ maximumEvidenceRefs: MAX_EVIDENCE_REFS_PER_RUN + 1 }));

    expect(caught).toBeInstanceOf(RunBudgetError);
    expect((caught as Error).message).toBe("maximum evidence refs exceed the launch ceiling");
  });

  it("has no admissible at-cap case: the byte budget binds first (FINDING)", () => {
    const caught = projectionError(shape({ maximumEvidenceRefs: MAX_EVIDENCE_REFS_PER_RUN }));

    expect(caught).toBeInstanceOf(RunBudgetError);
    expect((caught as Error).message).toBe("projected ordinary run consumes reserved control headroom");
  });
});

describe("whole-run transition cap", () => {
  it("refuses one transition over the cap, naming the cap", () => {
    const total = MAX_TRANSITIONS_PER_RUN + 1;
    const caught = projectionError(shape({ maximumTransitions: total - ALLOWANCE }));

    expect(caught).toBeInstanceOf(RunBudgetError);
    expect((caught as Error).message).toBe("projected run exceeds the 3,200 transition cap");
  });

  it("has no admissible at-cap case: the byte budget binds first (FINDING)", () => {
    const caught = projectionError(shape({ maximumTransitions: MAX_TRANSITIONS_PER_RUN - ALLOWANCE }));

    expect(caught).toBeInstanceOf(RunBudgetError);
    expect((caught as Error).message).toBe("projected ordinary run consumes reserved control headroom");
  });
});

describe("serialized write lanes", () => {
  const ordinaryLimit = MAX_PREPARATION_RUN_BYTES - PREPARATION_RUN_CONTROL_RESERVE_BYTES;

  it("admits an ordinary write of exactly the non-reserved budget", () => {
    expect(() => assertPreparationRunWriteBudget(ordinaryLimit, "ordinary")).not.toThrow();
  });

  it("refuses an ordinary write one byte past the non-reserved budget", () => {
    expect(() => assertPreparationRunWriteBudget(ordinaryLimit + 1, "ordinary")).toThrow(RunBudgetError);
  });

  it("admits a control write of exactly the record cap", () => {
    expect(() => assertPreparationRunWriteBudget(MAX_PREPARATION_RUN_BYTES, "control")).not.toThrow();
  });

  it("refuses either lane one byte past the record cap", () => {
    // The record cap bounds BOTH lanes; the reserve only moves where the
    // ordinary lane stops. A control write is not an escape from the cap itself.
    expect(() => assertPreparationRunWriteBudget(MAX_PREPARATION_RUN_BYTES + 1, "control")).toThrow(RunBudgetError);
    expect(() => assertPreparationRunWriteBudget(MAX_PREPARATION_RUN_BYTES + 1, "ordinary")).toThrow(RunBudgetError);
  });
});
