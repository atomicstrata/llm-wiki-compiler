/**
 * Standard failure entry point. The engine receives explicit persistence;
 * the public operation retains its original arguments and compiler host.
 */
export { markRunFailedLocked, failWorkflowWithHost } from "@atomicstrata/llmwiki-local-workflows";
import { failWorkflowWithHost } from "@atomicstrata/llmwiki-local-workflows";
import { createLocalWorkflowHost } from "./host.js";
import type { WorkflowRun } from "@atomicstrata/llmwiki-core/local-workflow-contracts";

/** Fail through the standard compiler host. */
export async function failWorkflow(root: string, runId: string, detail: string): Promise<WorkflowRun> {
  return failWorkflowWithHost(createLocalWorkflowHost(), root, runId, detail);
}
