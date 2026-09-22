/**
 * @file src/workflows/start.ts
 * @description Legacy start API composition. Public signatures and caller-held-lock
 * preconditions remain unchanged; the algorithm uses the same constructed host
 * as the new runtime. The locked entry point deliberately does not reacquire.
 */
import { createLocalWorkflowHost } from "./host.js";
import { startWorkflowWithHost, startWorkflowWithServices } from "@atomicstrata/llmwiki-local-workflows";
import { mintRunId } from "@atomicstrata/llmwiki-local-workflows";
import { writeRunWithCallerHeldLock } from "@atomicstrata/llmwiki-core/compiler-legacy-workflows";
import type { BlockingLockOptions } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { WorkflowRun } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
export { UnknownWorkflowError, TooManyActiveRunsError, WorkflowRunStoreUnavailableError } from "@atomicstrata/llmwiki-local-workflows";
export { WorkflowInputsTooLargeError } from "./input-snapshot.js";
export { lookupWorkflowDef } from "@atomicstrata/llmwiki-core/local-workflow-contracts";

const legacyHost = createLocalWorkflowHost();

/** Preserve the existing self-locking start signature and input snapshot timing. */
export function startWorkflow(
  root: string, workflowId: string, inputs: Record<string, unknown>,
  mintId: (workflowId: string) => string = mintRunId,
  lockOptions: BlockingLockOptions = {},
  processOptions: { workspaceId?: string; required?: boolean } = {},
): Promise<WorkflowRun> {
  return startWorkflowWithHost(legacyHost, { root, workflowId, inputs, mintId, lockOptions, processOptions });
}

/**
 * Explicit compatibility path: the caller already holds the compiler lock.
 * No new token argument, lock acquisition, or claim of proven ownership is added.
 */
export function startWorkflowLocked(
  root: string, workflowId: string, inputs: Record<string, unknown>,
  mintId: (workflowId: string) => string = mintRunId,
  processOptions: { workspaceId?: string; required?: boolean } = {},
): Promise<WorkflowRun> {
  return startWorkflowWithServices({
    host: legacyHost, root, persist: run => writeRunWithCallerHeldLock(root, run),
  }, workflowId, inputs, mintId, processOptions);
}

/** Preserve the product/workspace-bound start convenience API. */
export function startProductWorkflow(
  root: string, workspaceId: string, workflowId: string, inputs: Record<string, unknown>,
): Promise<WorkflowRun> {
  return startWorkflow(root, workflowId, inputs, mintRunId, {}, { workspaceId, required: true });
}
