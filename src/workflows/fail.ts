/**
 * @file src/workflows/fail.ts
 * @description The `fail` operation: route an active run to terminal `failed`.
 *
 * `fail` moves an ACTIVE run to the terminal `failed` status under the project
 * lock and with a fail-closed read, recording a `detail` reason. The current
 * stage's log entry (if any) is marked `failed` too, so the run records WHERE it
 * stopped. The version bump + `run-failed` event are stamped atomically via
 * {@link commitTerminalEvent}, which COMPACTS the event trail at the event cap and
 * MINIMIZES the record at the byte cap so a capped run is always retireable (a cap
 * bounds growth, never termination). This is exposed for the next slice's execution-failure
 * routing (a write/trust stage that fails mid-execution) and is tested directly
 * here. A terminal run cannot be re-failed ({@link RunNotActiveError}).
 */

import { RunNotActiveError } from "./errors.js";
import { assertDetailWithinCap } from "./field-limits.js";
import { withRunLock, isTerminalStatus, commitTerminalEvent } from "./with-lock.js";
import { maybeAutoProject } from "./projection.js";
import type { WorkflowRun } from "./types.js";

/** Return a NEW run with the current stage's log entry (if any) set to `failed`. */
function markCurrentStageFailed(run: WorkflowRun): WorkflowRun {
  if (run.currentStage === null) return run;
  return {
    ...run,
    stageLog: run.stageLog.map((entry) =>
      entry.stageId === run.currentStage ? { ...entry, status: "failed" } : entry,
    ),
  };
}

/**
 * The LOCK-FREE core of `fail`: route an ACTIVE `run` to terminal `failed`,
 * recording `detail`, and persist it. The CALLER must already hold the project
 * lock for this run (this neither acquires nor releases it). Factored out of
 * {@link failWorkflow} so the stage-output write path can CO-COMMIT a failure under
 * its OWN already-held lock when a hard-denied submit refuses the write — routing
 * the run to `failed` (retryable via `resume`) instead of leaving it stuck
 * `awaiting-output`. Caps `detail` and refuses an already-terminal run identically
 * to the locked entry point.
 *
 * @param root - Absolute project root.
 * @param run - The validated, lock-held run to fail.
 * @param detail - Human-readable reason recorded on the `run-failed` event.
 * @returns The persisted, failed run.
 * @throws {RunNotActiveError} When the run is already terminal.
 * @throws {WorkflowFieldTooLongError} When `detail` exceeds its size cap.
 */
export async function markRunFailedLocked(root: string, run: WorkflowRun, detail: string): Promise<WorkflowRun> {
  assertDetailWithinCap(detail);
  if (isTerminalStatus(run.status)) throw new RunNotActiveError(run.runId, run.status);
  const at = new Date().toISOString();
  const staged = markCurrentStageFailed(run);
  return commitTerminalEvent(root, staged, { type: "run-failed", at, actorKind: "system", detail }, {
    status: "failed",
  });
}

/**
 * Fail an active run (move it to terminal `failed`), recording `detail`.
 *
 * @param root - Absolute project root.
 * @param runId - The slug-safe run id to fail.
 * @param detail - Human-readable reason recorded on the `run-failed` event.
 * @returns The persisted, failed run.
 * @throws {LockBusyError} When the project lock is held.
 * @throws {RunUnavailableError} When the run is absent/unavailable.
 * @throws {RunNotActiveError} When the run is already terminal.
 * @throws {WorkflowFieldTooLongError} When `detail` exceeds its size cap.
 */
export async function failWorkflow(root: string, runId: string, detail: string): Promise<WorkflowRun> {
  assertDetailWithinCap(detail); // fail fast on an over-long detail BEFORE acquiring the lock
  const run = await withRunLock(root, runId, (locked) => markRunFailedLocked(root, locked, detail));
  await maybeAutoProject(root, run);
  return run;
}
