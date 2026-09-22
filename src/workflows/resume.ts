/**
 * Standard-distribution compatibility entry points for resume.
 * Host construction stays here; optional engine operations receive a host.
 */
export { resumeWorkflowWithHost } from "@atomicstrata/llmwiki-local-workflows";
import { resumeWorkflowWithHost } from "@atomicstrata/llmwiki-local-workflows";
import { createLocalWorkflowHost } from "./host.js";
import type { WorkflowRun } from "@atomicstrata/llmwiki-core/local-workflow-contracts";


/**
 * Resume a `failed` run (retry), or report an already-active run's position.
 *
 * `failed` → restores the current stage to `running`, CLEARS the retried stage's
 * stale output + gate + pending intent ({@link clearStageForRetry}, so the retry
 * genuinely re-executes), records `run-resumed`, sets `running`, persists, returns.
 * `running`/`pending` → returns unchanged (no event). `completed`/`cancelled` →
 * throws {@link RunNotActiveError}.
 *
 * @param root - Absolute project root.
 * @param runId - The slug-safe run id to resume.
 * @returns The persisted (or unchanged) run.
 * @throws {LockBusyError} When the project lock is held.
 * @throws {RunUnavailableError} When the run is absent/unavailable.
 * @throws {RunNotActiveError} When the run is `completed`/`cancelled`.
 */
export async function resumeWorkflow(root: string, runId: string): Promise<WorkflowRun> {
  return resumeWorkflowWithHost(createLocalWorkflowHost(), root, runId);
}
