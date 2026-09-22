/**
 * Standard-distribution compatibility entry points for approve-human-interactively.
 * Host construction stays here; optional engine operations receive a host.
 */
export { approveHumanGateWithHost } from "@atomicstrata/llmwiki-local-workflows";
import { approveHumanGateWithHost } from "@atomicstrata/llmwiki-local-workflows";
import { createLocalWorkflowHost } from "./host.js";
import type { WorkflowRun } from "@atomicstrata/llmwiki-core/local-workflow-contracts";



/** Approve only the exact subject confirmed through this process's terminal. */
export async function approveHumanGateInteractively(root: string, runId: string, gateId: string): Promise<WorkflowRun> {
  return approveHumanGateWithHost(createLocalWorkflowHost(), root, runId, gateId);
}
