/**
 * @file src/workflows/cancel.ts
 * @description The `cancel` operation: terminate an active run.
 *
 * `cancel` moves an ACTIVE run to the terminal `cancelled` status under the
 * project lock and with a fail-closed read. A terminal run cannot be re-cancelled
 * ({@link RunNotActiveError}). The version bump + `run-cancelled` event are
 * stamped atomically via {@link commitTerminalEvent}, which (unlike a normal
 * append) COMPACTS the event trail at the event cap and MINIMIZES the record at
 * the byte cap so a capped run is never an un-retireable zombie: a cap bounds
 * GROWTH, never blocks TERMINATION. The status/current-stage edits are applied to
 * its result and persisted through the confined store.
 */

import { RunNotActiveError } from "./errors.js";
import { withRunLock, isTerminalStatus, commitTerminalEvent } from "./with-lock.js";
import { maybeAutoProject } from "./projection.js";
import type { WorkflowRun } from "./types.js";

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
  const run = await withRunLock(root, runId, async (locked) => {
    if (isTerminalStatus(locked.status)) throw new RunNotActiveError(runId, locked.status);
    const at = new Date().toISOString();
    return commitTerminalEvent(root, locked, { type: "run-cancelled", at, actorKind: "system" }, {
      status: "cancelled",
      currentStage: null,
    });
  });
  await maybeAutoProject(root, run);
  return run;
}
