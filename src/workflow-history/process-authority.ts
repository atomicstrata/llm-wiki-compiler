/**
 * @file src/workflow-history/process-authority.ts
 * @description Resolves and revalidates the optional product process authority
 * sealed on a workflow run. Legacy profiles and products without a canonical
 * process definition remain unchanged; a product that opts in must bind one
 * explicit workspace and the active runtime components before any run operation.
 *
 * ONE BODY EACH, over {@link ActiveProductSources}: {@link resolveWorkflowProcessAuthorityFrom}
 * (a new run's authority) and {@link assertCurrentWorkflowProcessAuthorityFrom} (a
 * sealed run's revalidation). Each root form keeps its signature and passes the
 * local disk sources; each body resolves the product once per call. The root
 * forms resolve through {@link activeProductForLockHold}, so inside one lock-held
 * section they share the one resolution the profile load of that section makes.
 */

import { canonicalDigest } from "../profile/templates/signing/canonical.js";
import { assertWorkspaceId } from "../preparations/paths.js";
import { resolveActiveProductFrom, type ActiveProductResolution, type ActiveProductSources } from "../products/binding/resolve.js";
import { activeProductForLockHold } from "../profile/load.js";
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
  return processAuthorityOf(await activeProductForLockHold(root), workspaceId, required);
}

/** {@link resolveWorkflowProcessAuthority} over {@link ActiveProductSources}. */
export async function resolveWorkflowProcessAuthorityFrom(
  sources: ActiveProductSources, workspaceId?: string, required = false,
): Promise<WorkflowProcessAuthorityV1 | undefined> {
  return processAuthorityOf(await resolveActiveProductFrom(sources), workspaceId, required);
}

/** THE ONE BODY of a new run's authority, over the resolved product. */
function processAuthorityOf(
  active: ActiveProductResolution, workspaceId: string | undefined, required: boolean,
): WorkflowProcessAuthorityV1 | undefined {
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
  assertProcessAuthorityCurrent(await activeProductForLockHold(root), run);
}

/** {@link assertCurrentWorkflowProcessAuthority} over {@link ActiveProductSources}. It resolves the product once per call and remembers nothing. */
export async function assertCurrentWorkflowProcessAuthorityFrom(
  sources: ActiveProductSources, run: WorkflowRun,
): Promise<void> {
  assertProcessAuthorityCurrent(await resolveActiveProductFrom(sources), run);
}

/** THE ONE BODY of a sealed run's revalidation, over the resolved product. */
function assertProcessAuthorityCurrent(active: ActiveProductResolution, run: WorkflowRun): void {
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
