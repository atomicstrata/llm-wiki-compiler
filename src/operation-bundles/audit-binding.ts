/**
 * @file src/operation-bundles/audit-binding.ts
 * @description The exact three-part identity every store adapter stamps onto its
 * child audit record so crash replay can match a persisted effect back to one
 * deterministic mutation. The binding is constructed field-by-field from an
 * authenticated run binding; it never spreads caller input, so a caller cannot
 * forge the identity fields that the child event checksum covers.
 */

import {
  assertBundleId, assertMutationId, assertOperationRunId,
  type BundleId, type MutationId, type OperationRunId,
} from "./ids.js";
import type { OperationRunBinding } from "./run-types.js";

/** The bundle/run/mutation identity carried by one operation-bound audit record. */
export interface OperationAuditBinding {
  bundleId: BundleId;
  runId: OperationRunId;
  mutationId: MutationId;
}

/**
 * Construct a validated audit binding, naming and re-asserting each identity
 * field from the run binding and the deterministic mutation identity. The
 * mutation's membership in the bundle is the executor's manifest check; this
 * seam only guarantees each field is a well-formed typed identity.
 */
export function operationAuditBinding(
  runBinding: OperationRunBinding,
  mutation: MutationId,
): OperationAuditBinding {
  return {
    bundleId: assertBundleId(runBinding.bundleId),
    runId: assertOperationRunId(runBinding.runId),
    mutationId: assertMutationId(mutation),
  };
}
