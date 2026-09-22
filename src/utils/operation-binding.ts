/**
 * @file src/utils/operation-binding.ts
 * @description The on-disk operation binding carried by an authority record
 * (relation, event, catalog) that a bundle apply produced, so crash replay can
 * match a persisted effect back to one deterministic mutation. The fields are
 * plain strings validated against the same identifier grammar as
 * `src/operation-bundles/ids.ts`; the grammar is mirrored here (not imported) so
 * the relation and event stores never take a dependency on the operation-bundles
 * layer. Adapters construct the binding from an already-validated
 * `OperationAuditBinding`; this module re-validates it at the untrusted disk
 * read boundary.
 */

/** The bundle/run/mutation identity stamped onto one operation-bound record. */
export interface OperationBinding {
  bundleId: string;
  runId: string;
  mutationId: string;
}

const BUNDLE_ID_PATTERN = /^bnd_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const RUN_ID_PATTERN = /^opr_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const MUTATION_ID_PATTERN = /^opm_[0-9a-f]{64}$/;

/** Whether a value is a well-formed operation binding by identifier grammar. */
export function isOperationBinding(value: unknown): value is OperationBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !["bundleId", "runId", "mutationId"].every((key) => keys.includes(key))) {
    return false;
  }
  const binding = value as Record<string, unknown>;
  return typeof binding.bundleId === "string" && BUNDLE_ID_PATTERN.test(binding.bundleId)
    && typeof binding.runId === "string" && RUN_ID_PATTERN.test(binding.runId)
    && typeof binding.mutationId === "string" && MUTATION_ID_PATTERN.test(binding.mutationId);
}

/** Re-validate and rebuild an exact binding, naming each field (never spread). */
export function assertOperationBinding(value: unknown): OperationBinding {
  if (!isOperationBinding(value)) throw new Error("operation binding is malformed");
  return { bundleId: value.bundleId, runId: value.runId, mutationId: value.mutationId };
}

/** Whether two bindings name the same bundle, run, and mutation. */
export function operationBindingEquals(left: OperationBinding, right: OperationBinding): boolean {
  return left.bundleId === right.bundleId && left.runId === right.runId
    && left.mutationId === right.mutationId;
}
