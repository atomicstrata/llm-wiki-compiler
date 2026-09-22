/**
 * @file test/capability-providers/custody.test.ts
 * @description Pre-launch custody feasibility (D6.4). Declared output validators
 * whose worst-case scans cannot fit the effective custody scan-byte, output, or
 * file ceilings are unavailable before any provider starts, distinct from
 * runtime exhaustion.
 */
import { describe, expect, it } from "vitest";
import {
  assessCustodyFeasibility, type CustodyBudgetV1, type DeclaredCustodyValidatorV1,
} from "../../src/capability-providers/runtime/custody.js";

const BUDGET: CustodyBudgetV1 = { scanBytes: 1_000_000, wallTimeMs: 60_000, outputBytes: 500_000, outputFiles: 4 };

function validator(outputId: string, maxOutputBytes: number, passes = 1, wallTimeMs = 1_000): DeclaredCustodyValidatorV1 {
  return { outputId, maxOutputBytes, worstCaseScanPasses: passes, worstCaseWallTimeMs: wallTimeMs };
}

describe("pre-launch custody feasibility", () => {
  it("accepts validators that fit every ceiling", () => {
    const result = assessCustodyFeasibility([validator("a", 100_000), validator("b", 100_000, 2)], BUDGET);
    expect(result.kind).toBe("feasible");
    if (result.kind === "feasible") {
      expect(result.plannedScanBytes).toBe(300_000);
      expect(result.declaredOutputBytes).toBe(200_000);
    }
  });

  it("refuses when worst-case scan passes exceed the scan ceiling", () => {
    const result = assessCustodyFeasibility([validator("a", 400_000, 3)], BUDGET);
    expect(result.kind).toBe("infeasible");
    if (result.kind === "infeasible") expect(result.dimension).toBe("custodyScanBytes");
  });

  it("refuses when declared output bytes exceed the output ceiling", () => {
    const result = assessCustodyFeasibility([validator("a", 400_000), validator("b", 200_000)], BUDGET);
    expect(result.kind).toBe("infeasible");
    if (result.kind === "infeasible") expect(result.dimension).toBe("outputBytes");
  });

  it("refuses when worst-case wall time exceeds the wall-time ceiling", () => {
    const result = assessCustodyFeasibility([validator("a", 1_000, 1, 40_000), validator("b", 1_000, 1, 40_000)], BUDGET);
    expect(result.kind).toBe("infeasible");
    if (result.kind === "infeasible") expect(result.dimension).toBe("custodyWallTimeMs");
  });

  it("refuses when the declared output count exceeds the file ceiling", () => {
    const many = Array.from({ length: 5 }, (_, index) => validator(`o${index}`, 1_000));
    const result = assessCustodyFeasibility(many, BUDGET);
    expect(result.kind).toBe("infeasible");
    if (result.kind === "infeasible") expect(result.dimension).toBe("outputFiles");
  });

  it("refuses a validator declaring fewer than one scan pass", () => {
    const result = assessCustodyFeasibility([validator("a", 1_000, 0)], BUDGET);
    expect(result.kind).toBe("infeasible");
    if (result.kind === "infeasible") expect(result.dimension).toBe("custodyBudgetInvalid");
  });

  it("refuses a custody budget above the host scan ceiling", () => {
    const result = assessCustodyFeasibility([validator("a", 1_000)], { ...BUDGET, scanBytes: Number.MAX_SAFE_INTEGER });
    expect(result.kind).toBe("infeasible");
    if (result.kind === "infeasible") expect(result.dimension).toBe("custodyBudgetInvalid");
  });
});
