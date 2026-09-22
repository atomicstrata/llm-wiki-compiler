/**
 * @file src/capability-providers/runtime/custody.ts
 * @description Provider V2 evidence custody planning. The pre-launch
 * feasibility gate proves the declared output validators' worst-case scans fit
 * the effective custody scan-byte and output ceilings before any provider
 * starts, so an output contract that cannot be custodied is unavailable rather
 * than discovered mid-run. Runtime exhaustion (D6.4, result-level) is a
 * distinct, separately reported outcome carried by CustodyOutcomeV1.
 */
import {
  MAX_ACCEPTED_OUTPUT_BYTES, MAX_ACCEPTED_OUTPUT_FILES, MAX_CUSTODY_SCAN_BYTES,
  MAX_CUSTODY_WALL_TIME_MS,
} from "../constants.js";

/** Effective custody ceilings resolved as the minimum before launch. */
export interface CustodyBudgetV1 {
  readonly scanBytes: number;
  readonly wallTimeMs: number;
  readonly outputBytes: number;
  readonly outputFiles: number;
}

/** One declared output's worst-case custody cost the host must be able to pay. */
export interface DeclaredCustodyValidatorV1 {
  readonly outputId: string;
  readonly maxOutputBytes: number;
  readonly worstCaseScanPasses: number;
  readonly worstCaseWallTimeMs: number;
}

/** Closed feasibility result; infeasible names the exhausted dimension. */
export type CustodyFeasibilityV1 =
  | {
      readonly kind: "feasible";
      readonly plannedScanBytes: number;
      readonly plannedWallTimeMs: number;
      readonly declaredOutputBytes: number;
    }
  | {
      readonly kind: "infeasible";
      readonly dimension: "custodyScanBytes" | "custodyWallTimeMs" | "outputBytes" | "outputFiles" | "custodyBudgetInvalid";
      readonly detail: string;
    };

/** Prove the declared validators fit the effective custody budget before launch. */
export function assessCustodyFeasibility(
  validators: readonly DeclaredCustodyValidatorV1[],
  budget: CustodyBudgetV1,
): CustodyFeasibilityV1 {
  const budgetError = validateBudget(budget);
  if (budgetError) return infeasible("custodyBudgetInvalid", budgetError);
  if (validators.length > budget.outputFiles) {
    return infeasible("outputFiles", `declared outputs ${validators.length} exceed the output-file ceiling ${budget.outputFiles}`);
  }
  let plannedScanBytes = 0;
  let plannedWallTimeMs = 0;
  let declaredOutputBytes = 0;
  for (const validator of validators) {
    const validatorError = validateValidator(validator);
    if (validatorError) return infeasible("custodyBudgetInvalid", validatorError);
    plannedScanBytes = safeAdd(plannedScanBytes, validator.maxOutputBytes * validator.worstCaseScanPasses);
    plannedWallTimeMs = safeAdd(plannedWallTimeMs, validator.worstCaseWallTimeMs);
    declaredOutputBytes = safeAdd(declaredOutputBytes, validator.maxOutputBytes);
  }
  if (declaredOutputBytes > budget.outputBytes) {
    return infeasible("outputBytes", `declared output bytes ${declaredOutputBytes} exceed the output ceiling ${budget.outputBytes}`);
  }
  if (plannedScanBytes > budget.scanBytes) {
    return infeasible("custodyScanBytes", `worst-case custody scan ${plannedScanBytes} exceeds the scan ceiling ${budget.scanBytes}`);
  }
  if (plannedWallTimeMs > budget.wallTimeMs) {
    return infeasible("custodyWallTimeMs", `worst-case custody wall time ${plannedWallTimeMs}ms exceeds the ceiling ${budget.wallTimeMs}ms`);
  }
  return Object.freeze({ kind: "feasible", plannedScanBytes, plannedWallTimeMs, declaredOutputBytes });
}

function validateBudget(budget: CustodyBudgetV1): string | null {
  if (!boundedCeiling(budget.scanBytes, MAX_CUSTODY_SCAN_BYTES)) return "custody scan-byte ceiling is out of range";
  if (!boundedCeiling(budget.wallTimeMs, MAX_CUSTODY_WALL_TIME_MS)) return "custody wall-time ceiling is out of range";
  if (!boundedCeiling(budget.outputBytes, MAX_ACCEPTED_OUTPUT_BYTES)) return "custody output-byte ceiling is out of range";
  if (!boundedCeiling(budget.outputFiles, MAX_ACCEPTED_OUTPUT_FILES)) return "custody output-file ceiling is out of range";
  return null;
}

function validateValidator(validator: DeclaredCustodyValidatorV1): string | null {
  if (!Number.isSafeInteger(validator.maxOutputBytes) || validator.maxOutputBytes < 0) {
    return `output ${validator.outputId} declares an invalid maximum byte count`;
  }
  if (!Number.isSafeInteger(validator.worstCaseScanPasses) || validator.worstCaseScanPasses < 1) {
    return `output ${validator.outputId} declares fewer than one custody scan pass`;
  }
  if (!Number.isSafeInteger(validator.worstCaseWallTimeMs) || validator.worstCaseWallTimeMs < 0) {
    return `output ${validator.outputId} declares an invalid worst-case wall time`;
  }
  return null;
}

function boundedCeiling(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function safeAdd(current: number, next: number): number {
  const total = current + next;
  if (!Number.isSafeInteger(total)) throw new Error("provider custody plan overflowed a safe integer");
  return total;
}

function infeasible(dimension: Extract<CustodyFeasibilityV1, { kind: "infeasible" }>["dimension"], detail: string): CustodyFeasibilityV1 {
  return Object.freeze({ kind: "infeasible", dimension, detail });
}
