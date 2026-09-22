/**
 * Standard-distribution compatibility entry points for list.
 * Host construction stays here; optional engine operations receive a host.
 */
export { listWorkflowsWithHost } from "@atomicstrata/llmwiki-local-workflows";
export type { WorkflowSummary } from "@atomicstrata/llmwiki-local-workflows";
import { listWorkflowsWithHost } from "@atomicstrata/llmwiki-local-workflows";
import { createLocalWorkflowHost } from "./host.js";
import type { WorkflowSummary } from "@atomicstrata/llmwiki-local-workflows";


/**
 * List the workflows declared in the project's profile.
 *
 * Loads the active profile and maps each declared workflow to a summary of its
 * id and stage ids (in declared order). The result is sorted by `workflowId` for
 * deterministic output. A project on the default profile (which declares no
 * `workflows`) yields an empty array.
 *
 * @param root - Absolute project root.
 * @returns The declared workflow summaries, sorted by `workflowId`.
 */
export async function listWorkflows(root: string): Promise<WorkflowSummary[]> {
  return listWorkflowsWithHost(createLocalWorkflowHost(), root);
}
