/**
 * @file src/workflows/resume.ts
 * @description The `resume` operation: re-activate a failed run, or report position.
 *
 * `resume` is the retry path for a `failed` run: under the project lock and with a
 * fail-closed read, it moves the run back to `running`, restoring the current
 * stage's log entry to `running`, and records a `run-resumed` event (version bump
 * via {@link appendRunEvent}). A run that is already `running`/`pending` is
 * returned UNCHANGED — resume is then a no-op position report (no event, no
 * version churn), though the lock is still acquired and released. A terminal
 * `completed`/`cancelled` run cannot be resumed ({@link RunNotActiveError}).
 *
 * GENUINE RETRY (not a replay): a retried stage's RECORDED work is CLEARED so the
 * retry RE-EXECUTES rather than treating the stage as already done. The current
 * stage's applied output (`outputs[currentStage]`), its gate (if any) in
 * `satisfiedGates`, and any in-flight `pendingOutput` for it are all removed
 * ({@link clearStageForRetry}). Otherwise `advance`'s `stageSatisfied` would read the
 * STALE output + gate and COMPLETE the stage WITHOUT re-doing the write, re-running
 * the Trust Guard, or re-requiring the gate approval — replaying a one-time human
 * approval across the retry. After the clear, `advance` re-parks the stage
 * (`awaiting-output`/`awaiting-gate`) so the write must be re-submitted and the gate
 * re-obtained.
 */

import { RunNotActiveError } from "./errors.js";
import { withRunLock, commitRunEvent } from "./with-lock.js";
import { resolveCurrentStage } from "./advance.js";
import { maybeAutoProject } from "./projection.js";
import type { WorkflowRun } from "./types.js";
import type { WorkflowStageDef } from "../profile/types.js";

/** Return a NEW run with the current stage's log entry (if any) set back to `running`. */
function markCurrentStageRunning(run: WorkflowRun): WorkflowRun {
  if (run.currentStage === null) return run;
  return {
    ...run,
    stageLog: run.stageLog.map((entry) =>
      entry.stageId === run.currentStage ? { ...entry, status: "running" } : entry,
    ),
  };
}

/**
 * Return a NEW run with the CURRENT stage's recorded work CLEARED for a genuine
 * retry: drop its applied output (`outputs[currentStage]`), remove its gate (if the
 * stage declares one) from `satisfiedGates`, and clear any `pendingOutput` intent
 * for it. So the next `advance` no longer sees the stage as satisfied — the write
 * must be re-submitted (re-running the Trust Guard) and the gate re-obtained. A run
 * with no current stage is returned unchanged.
 *
 * @param run - The failed run being resumed (its log already restored to `running`).
 * @param stage - The current stage def (its `gate` identifies what to un-satisfy).
 * @returns The run with the retried stage's output/gate/pending intent cleared.
 */
function clearStageForRetry(run: WorkflowRun, stage: WorkflowStageDef): WorkflowRun {
  if (run.currentStage === null) return run;
  const { [run.currentStage]: _staleOutput, ...outputs } = run.outputs;
  const satisfiedGates = run.satisfiedGates.filter((gate) => gate !== stage.gate);
  const clearedPending = run.pendingOutput?.stageId === run.currentStage;
  const { pendingOutput: _drop, ...rest } = run;
  return { ...(clearedPending ? rest : run), outputs, satisfiedGates };
}

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
  const run = await withRunLock(root, runId, async (locked) => {
    if (locked.status === "completed" || locked.status === "cancelled") {
      throw new RunNotActiveError(runId, locked.status);
    }
    if (locked.status !== "failed") return locked; // running/pending → informational no-op
    const at = new Date().toISOString();
    const running = markCurrentStageRunning(locked);
    const restored = locked.currentStage === null ? running : clearStageForRetry(running, (await resolveCurrentStage(root, locked)).stage);
    return commitRunEvent(root, restored, { type: "run-resumed", at, actorKind: "system" }, {
      status: "running",
    });
  });
  await maybeAutoProject(root, run);
  return run;
}
