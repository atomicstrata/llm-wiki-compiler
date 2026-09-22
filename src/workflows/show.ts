/**
 * Standard-distribution compatibility entry points for show.
 * Host construction stays here; optional engine operations receive a host.
 */
export { showWorkflowWithHost } from "@atomicstrata/llmwiki-local-workflows";
export type { WorkflowStageDetail, WorkflowDetail } from "@atomicstrata/llmwiki-local-workflows";
import { showWorkflowWithHost } from "@atomicstrata/llmwiki-local-workflows";
import { createLocalWorkflowHost } from "./host.js";
import type { WorkflowDetail } from "@atomicstrata/llmwiki-local-workflows";


/**
 * Show ONE declared workflow's full detail.
 *
 * Loads the active profile and resolves the named workflow via the OWN-property
 * lookup ({@link lookupWorkflowDef}); an undeclared id fails closed with
 * {@link UnknownWorkflowError} rather than returning an empty result. Surfaces each
 * stage's `reads`/`writes`/`gate`/`previousIds`, the workflow's `projectionFile`,
 * and the ids of every declared workflow action whose `workflow` targets this id.
 * Read-only: no lock, no write.
 *
 * @param root - Absolute project root.
 * @param workflowId - The declared workflow id to show.
 * @returns The workflow's full detail.
 * @throws {UnknownWorkflowError} When `workflowId` is not a declared workflow.
 */
export async function showWorkflow(root: string, workflowId: string): Promise<WorkflowDetail> {
  return showWorkflowWithHost(createLocalWorkflowHost(), root, workflowId);
}
