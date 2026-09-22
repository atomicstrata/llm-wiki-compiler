/**
 * Standard-distribution compatibility entry points for cancel.
 * Host construction stays here; optional engine operations receive a host.
 */
export { cancelWorkflowWithHost } from "@atomicstrata/llmwiki-local-workflows";
import { cancelWorkflowWithHost } from "@atomicstrata/llmwiki-local-workflows";
import { createLocalWorkflowHost } from "./host.js";
import type { WorkflowRun } from "@atomicstrata/llmwiki-core/local-workflow-contracts";


/**
 * Cancel an active run (move it to terminal `cancelled`).
 *
 * @param root - Absolute project root.
 * @param runId - The slug-safe run id to cancel.
 * @returns The persisted, cancelled run.
 * @throws {LockBusyError} When the project lock is held.
 * @throws {RunUnavailableError} When the run is absent/unavailable.
 * @throws {RunNotActiveError} When the run is already terminal.
 */
export async function cancelWorkflow(root: string, runId: string): Promise<WorkflowRun> {
  return cancelWorkflowWithHost(createLocalWorkflowHost(), root, runId);
}
