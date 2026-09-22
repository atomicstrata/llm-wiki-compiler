/**
 * @file src/preparations/lifecycle-snapshot/classifier-types.ts
 * @description Internal two-pass classifier DTOs shared by quarantine and prune
 * classifiers without exposing raw authority records in the public snapshot.
 */

import type {
  PreparationLifecycleOperationV1,
  PreparationLifecycleProblemV1,
  PreparationLifecycleUnitV1,
} from "./types.js";

/** Positive active-key retirement evidence emitted by one completed reset. */
export interface LifecycleRetirementEvidence {
  readonly unitId: string;
  readonly receiptDigest: string;
}

/** Pass-one result awaiting optional historical reconciliation. */
export interface LifecyclePassOneUnit {
  readonly unit: PreparationLifecycleUnitV1;
  readonly problem?: PreparationLifecycleProblemV1;
  readonly retirementEvidence: readonly LifecycleRetirementEvidence[];
  readonly historicalCandidateDigest?: string;
  readonly historicalCandidateOperation?: PreparationLifecycleOperationV1;
}

/** Why an observed unit cannot proceed to its registry-specific classifier. */
function lifecycleObservationRefusal(
  observation: {
    readonly problem?: {
      readonly code: PreparationLifecycleProblemV1["code"];
      readonly detail: string;
    };
    readonly directory?: unknown;
  },
): { code: PreparationLifecycleProblemV1["code"]; detail: string } | null {
  if (observation.problem !== undefined) return observation.problem;
  return observation.directory === undefined
    ? { code: "unit-unavailable", detail: "unit unavailable" }
    : null;
}

/** Closed pre-classifier disposition shared by both physical registries. */
export function lifecycleObservationDisposition(
  observation: {
    readonly problem?: {
      readonly code: PreparationLifecycleProblemV1["code"];
      readonly detail: string;
    };
    readonly directory?: { readonly names: readonly string[] };
  },
): {
  status: "unavailable";
  code: PreparationLifecycleProblemV1["code"];
  detail: string;
} | { status: "inert" } | { status: "ready" } {
  const refusal = lifecycleObservationRefusal(observation);
  if (refusal !== null) return { status: "unavailable", ...refusal };
  return observation.directory?.names.length === 0
    ? { status: "inert" }
    : { status: "ready" };
}
