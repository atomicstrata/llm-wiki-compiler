/**
 * @file src/local-workflows/cancel.ts
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
import { withHostRunLock, isTerminalStatus, commitTerminalEvent } from "./with-lock.js";
import type { LocalWorkflowHost } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { terminalRunWriter, projectWithHost } from "./execution-context.js";
import type { WorkflowRun } from "@atomicstrata/llmwiki-core/local-workflow-contracts";

/** Cancel through the supplied host using the existing terminal transition policy. */
export async function cancelWorkflowWithHost(host: LocalWorkflowHost, root: string, runId: string): Promise<WorkflowRun> {
  const run = await withHostRunLock(host, root, runId, async (locked, context) => {
    if (isTerminalStatus(locked.status)) throw new RunNotActiveError(runId, locked.status);
    const at = new Date().toISOString();
    return commitTerminalEvent(root, locked, { type: "run-cancelled", at, actorKind: "system" }, {
      status: "cancelled",
      currentStage: null,
    }, terminalRunWriter(context));
  });
  await projectWithHost(host, root, run);
  return run;
}
