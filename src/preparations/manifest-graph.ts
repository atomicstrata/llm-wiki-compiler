/**
 * @file src/preparations/manifest-graph.ts
 * @description Cross-manifest supersession validation for the preparation
 * manifest store (design section 8.1). This is the home for the Task 1
 * supersession negatives that could only be shape-checked there: a manifest
 * resolves OTHER manifests, so self-reference, a cross-workspace target, a
 * dangling target, a cycle, and a fork with a required successor are all
 * rejected here, over the whole resolved set. The check is pure and read-only.
 *
 * Fork policy note: the design admits forks except "forks where one successor
 * is required". Absent a concrete "required successor" marker in the manifest
 * grammar, this validator fails closed and rejects EVERY multi-successor fork;
 * a future task that introduces the required-successor distinction may relax it.
 */

import type { PreparationId } from "./ids.js";
import type { PreparationManifestV1 } from "./manifest-parse.js";
import { PreparationPlanError } from "./problems.js";

/** One node in the resolved supersession graph. */
interface SupersessionNode {
  preparationId: PreparationId;
  workspaceId: string;
  supersedes?: PreparationId;
}

/** Build the by-id index and reject duplicate preparation identities. */
function indexManifests(manifests: readonly PreparationManifestV1[]): Map<PreparationId, SupersessionNode> {
  const byId = new Map<PreparationId, SupersessionNode>();
  for (const manifest of manifests) {
    if (byId.has(manifest.preparationId)) {
      throw new PreparationPlanError("preparation manifest identity appears more than once");
    }
    byId.set(manifest.preparationId, {
      preparationId: manifest.preparationId, workspaceId: manifest.workspaceId,
      ...(manifest.supersedesPreparationId === undefined ? {} : { supersedes: manifest.supersedesPreparationId }),
    });
  }
  return byId;
}

/** Reject self-reference, cross-workspace, and dangling supersession targets. */
function assertEdgesResolve(byId: Map<PreparationId, SupersessionNode>): void {
  for (const node of byId.values()) {
    if (node.supersedes === undefined) continue;
    if (node.supersedes === node.preparationId) throw new PreparationPlanError("preparation supersedes itself");
    const target = byId.get(node.supersedes);
    if (target === undefined) throw new PreparationPlanError("preparation supersedes a dangling target");
    if (target.workspaceId !== node.workspaceId) throw new PreparationPlanError("preparation supersedes a cross-workspace target");
  }
}

/** Reject a predecessor superseded by more than one successor (a fork). */
function assertNoForks(byId: Map<PreparationId, SupersessionNode>): void {
  const successors = new Map<PreparationId, number>();
  for (const node of byId.values()) {
    if (node.supersedes === undefined) continue;
    const count = (successors.get(node.supersedes) ?? 0) + 1;
    if (count > 1) throw new PreparationPlanError("preparation supersession fork is not permitted");
    successors.set(node.supersedes, count);
  }
}

/** Reject any cycle in the supersession chain. */
function assertNoCycles(byId: Map<PreparationId, SupersessionNode>): void {
  for (const start of byId.values()) {
    const seen = new Set<PreparationId>([start.preparationId]);
    let cursor: PreparationId | undefined = start.supersedes;
    while (cursor !== undefined) {
      if (seen.has(cursor)) throw new PreparationPlanError("preparation supersession chain contains a cycle");
      seen.add(cursor);
      cursor = byId.get(cursor)?.supersedes;
    }
  }
}

/** Validate the complete resolved supersession graph over a manifest set. */
export function validatePreparationSupersessionSet(manifests: readonly PreparationManifestV1[]): void {
  const byId = indexManifests(manifests);
  assertEdgesResolve(byId);
  assertNoForks(byId);
  assertNoCycles(byId);
}
