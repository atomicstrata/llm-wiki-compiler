/**
 * @file src/workflows/advance.ts
 * @description The `advance` operation for READ-ONLY / GATE-ONLY stages.
 *
 * `advance` moves an active run forward by ONE stage, under the project lock and
 * with a fail-closed read. A stage COMPLETES only when its work is done
 * ({@link stageSatisfied}): a `human:`/`agent:` gate must be in `satisfiedGates`;
 * a `trust:`-gated stage's gate must be in `satisfiedGates` (set by a successful
 * {@link submitStageOutput} apply, NOT by `gate approve`); a stage declaring
 * non-empty `writes` ADDITIONALLY needs its output recorded in
 * `run.outputs[stage.id]`. A stage with neither a gate nor writes is trivially
 * satisfied.
 *
 * When NOT satisfied the current stage is PARKED, not crashed. An unmet
 * `human:`/`agent:` gate parks `awaiting-gate` (the existing
 * {@link parkAwaitingGate} path). An unmet applied-output and/or unsatisfied
 * `trust:` gate — the cases a {@link submitStageOutput} call clears — parks with
 * the `awaiting-output` outcome (the stage-log marker reuses the `awaiting-gate`
 * status, since there is no separate per-stage status for a pending output; the
 * write/output-awaiting distinction lives at the OUTCOME level only).
 *
 * When satisfied the current stage is marked `completed`, the run steps to the
 * next stage (`running`) or, if that was the last stage, completes. The version
 * bump + `stage-advanced` event are stamped atomically via {@link appendRunEvent};
 * the stage/status edits are applied to its result, then persisted through the
 * confined store.
 */

import { loadProfile } from "../profile/load.js";
import { appendRunEvent } from "./events.js";
import { parseGate } from "./gates.js";
import { writeRun } from "./store.js";
import { UnknownWorkflowError, lookupWorkflowDef } from "./start.js";
import { RunNotActiveError, RunUnavailableError } from "./errors.js";
import { withRunLock, isTerminalStatus } from "./with-lock.js";
import { maybeAutoProject } from "./projection.js";
import type { BlockingLockOptions } from "../utils/lock.js";
import type { StageStatus, WorkflowRun } from "./types.js";
import type { WorkflowDef, WorkflowStageDef } from "../profile/types.js";

/** The result of advancing a run by one stage. */
export type AdvanceOutcome = "advanced" | "completed" | "awaiting-gate" | "awaiting-output";

/** A persisted run plus the outcome of the advance that produced it. */
export interface AdvanceResult {
  /** The run as persisted after the advance. */
  run: WorkflowRun;
  /** Whether the run advanced, completed, or is now awaiting a gate/output. */
  outcome: AdvanceOutcome;
}

/** The active run's resolved current stage: its workflow def, stage def, and project id. */
export interface ResolvedStage {
  /** The run's workflow def. */
  def: WorkflowDef;
  /** The current stage def. */
  stage: WorkflowStageDef;
  /** The active profile's `profileId` (the project identity for trusted-write grants). */
  projectId: string;
}

/** Find the stage def with `stageId`, or `undefined`. */
function stageDefOf(def: WorkflowDef, stageId: string): WorkflowStageDef | undefined {
  return def.stages.find((stage) => stage.id === stageId);
}

/** The id of the stage AFTER `stageId` in declaration order, or `null` if last/absent. */
function nextStageId(def: WorkflowDef, stageId: string): string | null {
  const index = def.stages.findIndex((stage) => stage.id === stageId);
  if (index < 0 || index + 1 >= def.stages.length) return null;
  return def.stages[index + 1].id;
}

/** Return a NEW run with `stageId`'s log entry set to `status` (other entries untouched). */
function setStageStatus(run: WorkflowRun, stageId: string, status: StageStatus): WorkflowRun {
  return {
    ...run,
    stageLog: run.stageLog.map((entry) => (entry.stageId === stageId ? { ...entry, status } : entry)),
  };
}

/** True when `stage`'s gate (any kind) is recorded in the run's `satisfiedGates`. */
function gateSatisfied(run: WorkflowRun, stage: WorkflowStageDef): boolean {
  return stage.gate === undefined || run.satisfiedGates.includes(stage.gate);
}

/**
 * True when `stage` declares writes and an output for it has been applied.
 * Uses an OWN-key presence check rather than truthiness so a legitimately FALSY
 * recorded output (`0`/`""`/`false`) still counts as recorded — a truthiness
 * check would park such a stage forever.
 */
function outputRecorded(run: WorkflowRun, stage: WorkflowStageDef): boolean {
  return (stage.writes.length === 0 && (stage.artifactWrites ?? []).length === 0) || Object.hasOwn(run.outputs, stage.id);
}

/**
 * True when the current stage's work is DONE: its gate (`human:`/`agent:`/`trust:`)
 * is in `satisfiedGates` AND — if it declares writes — its output is recorded in
 * `run.outputs[stage.id]`. A stage with both a gate and writes needs both; a
 * write-only stage needs just the applied output; a gate-only stage needs just the
 * gate; a stage with neither is trivially satisfied. A `trust:` gate is cleared by
 * the Trust-Guard apply ({@link submitStageOutput}), never by `gate approve`.
 */
function stageSatisfied(run: WorkflowRun, stage: WorkflowStageDef): boolean {
  return gateSatisfied(run, stage) && outputRecorded(run, stage);
}

/**
 * True when the stage's UNMET requirement is a `human:`/`agent:` gate awaiting
 * approval — the only case that parks `awaiting-gate`. A `trust:` gate (or a
 * missing applied output) instead awaits a {@link submitStageOutput} call and
 * parks `awaiting-output`, so it is excluded here.
 */
function awaitsHumanGate(run: WorkflowRun, stage: WorkflowStageDef): boolean {
  const parsed = stage.gate === undefined ? null : parseGate(stage.gate);
  if (parsed === null || parsed.kind === "trust") return false;
  return !run.satisfiedGates.includes(stage.gate as string);
}

/**
 * Persist a pure `awaiting-gate` stage marker on the current stage, idempotently.
 *
 * Backs BOTH park outcomes — an unmet `human:`/`agent:` gate (`awaiting-gate`) and
 * an unmet applied-output / `trust:` gate (`awaiting-output`): there is no separate
 * per-stage status for a pending output, so both reuse the `awaiting-gate`
 * stage-log marker and the OUTCOME alone distinguishes them. Reaching a park means
 * the run is in progress/waiting, so a `pending` run is flipped to `running` here.
 * This is a position/status marker, NOT a decision — it intentionally does NOT use
 * {@link appendRunEvent} and does NOT bump `stateVersion`. It is idempotent: when
 * the stage is ALREADY `awaiting-gate` and the status needs no change, it returns
 * the run untouched without re-writing.
 */
async function parkAwaitingGate(root: string, run: WorkflowRun, stageId: string): Promise<WorkflowRun> {
  const entry = run.stageLog.find((e) => e.stageId === stageId);
  const alreadyParked = entry?.status === "awaiting-gate";
  const status = run.status === "pending" ? "running" : run.status;
  if (alreadyParked && status === run.status) return run;
  const parked: WorkflowRun = { ...setStageStatus(run, stageId, "awaiting-gate"), status };
  await writeRun(root, parked);
  return parked;
}

/**
 * Complete the current stage and step the run to the next stage (or finish it).
 *
 * Stamps the version bump + `stage-advanced` event atomically via
 * {@link appendRunEvent}, THEN applies the stage edits to its result: the
 * completed stage's entry → `completed`; if a next stage exists it becomes the
 * `running` `currentStage` (and a still-`pending` run is flipped to `running`,
 * since it has now begun advancing), otherwise the run is `completed` with no
 * current stage. The mutated run is persisted and returned with its outcome.
 */
async function completeAndStep(root: string, run: WorkflowRun, def: WorkflowDef, stageId: string): Promise<AdvanceResult> {
  const at = new Date().toISOString();
  const bumped = appendRunEvent(run, { type: "stage-advanced", at, actorKind: "system", stageId });
  const completed = setStageStatus(bumped, stageId, "completed");
  const next = nextStageId(def, stageId);
  const runningStatus = run.status === "pending" ? "running" : run.status;
  const stepped: WorkflowRun =
    next === null
      ? { ...completed, currentStage: null, status: "completed" }
      : { ...setStageStatus(completed, next, "running"), currentStage: next, status: runningStatus };
  await writeRun(root, stepped);
  return { run: stepped, outcome: next === null ? "completed" : "advanced" };
}

/**
 * Resolve the active run's current stage def, failing closed on every gap.
 *
 * Loads the active profile, requires the run's workflow to still be declared
 * ({@link UnknownWorkflowError}), and finds the current stage def — a
 * null/missing/unknown `currentStage` on a non-terminal run is a fail-closed
 * fault ({@link RunUnavailableError} `"no-current-stage"`), never silent progress.
 */
export async function resolveCurrentStage(root: string, run: WorkflowRun): Promise<ResolvedStage> {
  const loaded = await loadProfile(root);
  const def = lookupWorkflowDef(loaded.profile.workflows, run.workflowId);
  if (def === undefined) throw new UnknownWorkflowError(run.workflowId);
  const stage = run.currentStage === null ? undefined : stageDefOf(def, run.currentStage);
  if (stage === undefined) throw new RunUnavailableError(run.runId, "no-current-stage");
  return { def, stage, projectId: loaded.profile.profileId };
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
  const result = await withRunLock<AdvanceResult>(root, runId, async (run) => {
    if (isTerminalStatus(run.status)) throw new RunNotActiveError(runId, run.status);
    const { def, stage } = await resolveCurrentStage(root, run);
    if (stageSatisfied(run, stage)) return completeAndStep(root, run, def, stage.id);
    const parked = await parkAwaitingGate(root, run, stage.id);
    return { run: parked, outcome: awaitsHumanGate(run, stage) ? "awaiting-gate" : "awaiting-output" };
  }, lockOptions);
  await maybeAutoProject(root, result.run);
  return result;
}
