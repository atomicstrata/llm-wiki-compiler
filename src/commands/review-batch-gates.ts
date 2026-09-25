/**
 * Conservative boundary for typed relation-gated approvals. The existing typed
 * validator reads live endpoint states, not a proposed batch overlay. A sibling
 * write could invalidate evidence after validation, so a gated candidate in a
 * multi-candidate promotion is refused before any writes. Single-item manifests
 * keep the existing typed validation semantics. Supporting dependent batches
 * requires a final-state overlay and is deliberately outside this command.
 */

import { loadNonDefaultProfile } from "../profile/block.js";
import { parseFrontmatter } from "../utils/markdown.js";
import type { PlannedReviewApproval } from "./review-batch-plan.js";

/** Retain ordinary approvals but require relation-gated typed writes to run individually. */
export async function rejectBatchRelationGates(
  root: string,
  approvals: PlannedReviewApproval[],
): Promise<PlannedReviewApproval[]> {
  if (approvals.length < 2 || !approvals.some(({ candidate }) => candidate.targetEntityType)) return approvals;
  const loaded = await loadNonDefaultProfile(root);
  if (!loaded) return approvals; // Typed planning already refuses a missing profile.
  return approvals.filter(({ candidate, result }) => {
    if (!candidate.targetEntityType) return true;
    const lifecycle = loaded.profile.entities[candidate.targetEntityType]?.lifecycle;
    if (!lifecycle) return true;
    const { meta } = parseFrontmatter(candidate.body);
    const enteredState = meta[lifecycle.field];
    if (typeof enteredState !== "string" || !lifecycle.transitionRelationRequirements?.[enteredState]?.length) return true;
    result.status = "invalid";
    result.error = "Relation-gated typed candidates must be approved individually; batch endpoint evidence is not supported.";
    return false;
  });
}
