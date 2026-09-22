/**
 * @file src/workflow-history/process-authority.ts
 * @description Resolves and revalidates the optional product process authority
 * sealed on a workflow run. Legacy profiles and products without a canonical
 * process definition remain unchanged; a product that opts in must bind one
 * explicit workspace and the active runtime components before any run operation.
 */

import { canonicalDigest } from "../profile/templates/signing/canonical.js";
import { assertWorkspaceId } from "../preparations/paths.js";
import { resolveActiveProduct } from "../products/binding/resolve.js";
import type { ActiveProductBindingV1 } from "../products/binding/types.js";
import type { Sha256Digest } from "../products/ids.js";
import type { WorkflowProcessAuthorityV1, WorkflowRun } from "./types.js";

/** A product process binding is absent, unavailable, or no longer current. */
export class WorkflowProcessAuthorityError extends Error {
  constructor(readonly reason: string) {
    super(`workflow process authority is ${reason}`);
    this.name = "WorkflowProcessAuthorityError";
  }
}

/** Canonical workspace composition governed by the active product binding. */
function compositionPreimage(binding: ActiveProductBindingV1, workspaceId: string) {
  return {
    schemaVersion: 1,
    workspaceId,
    runtimeAuthorityDigest: binding.runtimeAuthorityDigest,
    operationsPackDigest: binding.operationsPackDigest,
    knowledgeProfileDigest: binding.knowledgeProfileDigest,
    compositionLockDigest: binding.compositionLockDigest,
    processDefinitionDigest: binding.processDefinitionDigest,
  };
}

/** Build the exact run authority from one healthy active binding and workspace. */
function fromBinding(
  binding: ActiveProductBindingV1, workspaceId: string,
): WorkflowProcessAuthorityV1 | undefined {
  if (binding.processDefinitionDigest === undefined) return undefined;
  const id = assertWorkspaceId(workspaceId);
  return {
    schemaVersion: 1,
    productId: binding.productId,
    runtimeAuthorityDigest: binding.runtimeAuthorityDigest,
    processDefinitionDigest: binding.processDefinitionDigest,
    workspaceId: id,
    workspaceCompositionDigest: canonicalDigest(compositionPreimage(binding, id)) as Sha256Digest,
  };
}

/** Resolve product process authority for a new run, requiring explicit workspace. */
export async function resolveWorkflowProcessAuthority(
  root: string, workspaceId?: string, required = false,
): Promise<WorkflowProcessAuthorityV1 | undefined> {
  const active = await resolveActiveProduct(root);
  if (active.mode !== "product" || active.binding.processDefinitionDigest === undefined) {
    if (required) throw new WorkflowProcessAuthorityError("not-declared");
    return undefined;
  }
  if (workspaceId === undefined) throw new WorkflowProcessAuthorityError("missing-workspace");
  return fromBinding(active.binding, workspaceId);
}

/** Re-resolve and compare every sealed process/workspace authority field. */
export async function assertCurrentWorkflowProcessAuthority(
  root: string, run: WorkflowRun,
): Promise<void> {
  const active = await resolveActiveProduct(root);
  if (run.processAuthority === undefined) {
    if (active.mode === "product" && active.binding.processDefinitionDigest !== undefined) {
      throw new WorkflowProcessAuthorityError("missing-run-binding");
    }
    return;
  }
  if (active.mode !== "product") throw new WorkflowProcessAuthorityError("unavailable");
  const current = fromBinding(active.binding, run.processAuthority.workspaceId);
  if (current === undefined || canonicalDigest(current) !== canonicalDigest(run.processAuthority)) {
    throw new WorkflowProcessAuthorityError("stale-or-invalid");
  }
}

/** Refuse a caller attempting to operate a run through another workspace. */
export function assertRunWorkspace(run: WorkflowRun, workspaceId: string): void {
  const requested = assertWorkspaceId(workspaceId);
  if (run.processAuthority?.workspaceId !== requested) {
    throw new WorkflowProcessAuthorityError("workspace-mismatch");
  }
}
