/**
 * @file src/operation-bundles/run-residuals.ts
 * @description Shared pure derivation for abandonment residual identities,
 * compact canonical bindings, and manifest-owned namespace labels. Keeping
 * these rules in one module prevents the store and terminal parser from
 * independently deciding what unresolved work or authority a finding names.
 */

import { canonicalDigest } from "../profile/templates/signing/canonical.js";
import type { MutationId } from "./ids.js";
import type { OperationRunContent, ResidualFinding } from "./run-types.js";
import type { OperationDigest, OperationMutation } from "./types.js";

const AUTHORITATIVE_NAMESPACES: Readonly<Record<OperationMutation["kind"], string>> = {
  "source-retain": "workspace-sources",
  page: "wiki-pages",
  relation: "relations",
  "lifecycle-transition": "lifecycle",
  artifact: "artifacts",
  "catalog-record": "workspace-catalog",
  projection: "workspace-projections",
};

/** Bind one exact ordered finding set without embedding it in a transition. */
export function residualFindingsDigest(findings: readonly ResidualFinding[]): OperationDigest {
  return canonicalDigest({
    schemaVersion: 1,
    kind: "operation-run-residual-findings",
    findings,
  }) as OperationDigest;
}

/** Derive work not proved untouched, preexisting, or durably neutralized. */
export function unresolvedResidualIds(run: OperationRunContent): MutationId[] {
  const compensated = new Set(run.compensationOutcomes
    .filter((item) => item.status === "completed")
    .map((item) => item.mutationId));
  const mutations = run.obligations.authoritativeMutationIds.filter((id) => {
    const status = run.mutationOutcomes.find((item) => item.mutationId === id)?.status;
    if (status === "skipped-idempotent") return false;
    return status !== "applied" || !compensated.has(id);
  });
  const projections = run.obligations.projections
    .filter((item) => run.projectionOutcomes.find((outcome) => outcome.mutationId === item.mutationId)?.status !== "skipped-idempotent")
    .map((item) => item.mutationId);
  return [...mutations, ...projections];
}

/** Return the closed authority label selected only by manifest mutation kind. */
export function authoritativeNamespaceForMutation(mutation: OperationMutation): string {
  return AUTHORITATIVE_NAMESPACES[mutation.kind];
}
