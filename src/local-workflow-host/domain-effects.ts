/**
 * @file src/local-workflow-host/domain-effects.ts
 * @description Existing under-lock relation and lifecycle execution for the local
 * workflow host. Transaction lifetime is checked by host assembly; executor
 * authority and domain validation remain unchanged.
 */
import { applyApprovedMutationsLocked } from "../trust/executor.js";
import type { RelationPlannedMutation, LifecycleTransitionPlannedMutation, ArtifactPlannedMutation } from "../trust/planner.js";

/** Non-page mutation kinds coordinated by the workflow engine. */
export type LocalWorkflowDomainMutation = RelationPlannedMutation | LifecycleTransitionPlannedMutation | ArtifactPlannedMutation;

/** Apply only the declared domain mutation kinds through the existing executor. */
export function applyLocalWorkflowDomainEffects(root: string, planned: LocalWorkflowDomainMutation[]) {
  if (!planned.every(item => item.kind === "relation" || item.kind === "lifecycle-transition" || item.kind === "artifact")) {
    throw new Error("local workflow domain application requires relation, lifecycle or artifact mutations");
  }
  return applyApprovedMutationsLocked(root, planned);
}
