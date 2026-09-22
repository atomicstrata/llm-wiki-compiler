/**
 * Standard compatibility entry points for advance.
 * The engine receives services; this facade constructs the compiler host.
 */
export { advanceWorkflowWithHost } from "@atomicstrata/llmwiki-local-workflows";
export type { AdvanceOutcome, AdvanceResult, ResolvedStage } from "@atomicstrata/llmwiki-local-workflows";
import { advanceWorkflowWithHost } from "@atomicstrata/llmwiki-local-workflows";
import { createLocalWorkflowHost } from "./host.js";
import type { AdvanceResult, ResolvedStage } from "@atomicstrata/llmwiki-local-workflows";
import { resolveCurrentStage as resolveStageWithReader } from "@atomicstrata/llmwiki-local-workflows";
import { loadProfile } from "@atomicstrata/llmwiki-core";
import type { WorkflowRun } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { BlockingLockOptions } from "@atomicstrata/llmwiki-core/local-workflow-contracts";

/** Preserve the standard compiler reader for callers of the legacy helper. */
export async function resolveCurrentStage(root: string, run: WorkflowRun,
  readProfile: typeof loadProfile = loadProfile): Promise<ResolvedStage> {
  return resolveStageWithReader(root, run, readProfile);
}


/**
 * Advance an active run by one stage. See the file header for the full slice
 * contract (read-only/gate-only; writes & trust gates fail closed).
 *
 * @param root - Absolute project root.
 * @param runId - The slug-safe run id to advance.
 * @param lockOptions - Bounded-blocking acquire overrides (timeout/poll interval).
 * @returns The persisted run and the advance outcome.
 * @throws {LockBusyError} When the lock stays held past the bounded timeout.
 * @throws {RunUnavailableError} When the run is absent/unavailable or has no current stage.
 * @throws {RunNotActiveError} When the run is already terminal.
 * @throws {UnknownWorkflowError} When the run's workflow is no longer declared.
 */
export async function advanceWorkflow(root: string, runId: string, lockOptions: BlockingLockOptions = {}): Promise<AdvanceResult> {
  return advanceWorkflowWithHost(createLocalWorkflowHost(), root, runId, lockOptions);
}
