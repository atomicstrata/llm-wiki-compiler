/**
 * @file src/sdk/workflow-facade.ts
 * @description The EXPERIMENTAL workflow slice of the `Wiki` facade, factored out
 * of `src/sdk/wiki.ts` so the high-fan-in facade module stays lean.
 *
 * The read methods (`listActions`, `showAction`, `listWorkflows`,
 * `workflowStatus`) and the run-lifecycle
 * methods (`startWorkflow`, `advanceWorkflow`, `approveGate`, `cancelWorkflow`,
 * `resumeWorkflow`) run silently under the caller-supplied quiet wrapper and
 * delegate to the core workflow operations bound to `root`. `listWorkflows` and
 * `workflowStatus` are read-only; the rest mint/mutate a run under the project
 * lock and throw the same typed errors as the CLI (`UnknownWorkflowError`/
 * `LockBusyError`/`RunNotActiveError`/`GateActorMismatchError`/…).
 * `advanceWorkflow` completes a stage when satisfied or parks it
 * (`awaiting-gate`/`awaiting-output`); no wiki write happens here.
 * `submitStageOutput` is the ONE write-bearing method: it routes a typed
 * stage output through the scope-gated planner→executor seam (a write may land
 * live). `startWorkflow` defaults its `inputs` to `{}` when omitted. `runAction`
 * executes a declared action under the composed authority on the FIXED `sdk`
 * surface (the surface is not caller-overridable) and defaults `inputs` to `{}`.
 * `adaptDryRun` previews the per-run adaptation plan(s) read-only; `adaptWorkflowRun`
 * re-anchors a run to the changed def under the project lock (lossy needs `confirm`).
 * `projectWorkflowRun` writes a run's DERIVED markdown projection to its workflow's
 * `projectionFile` under `wiki/` (a one-way output; never mutates run state).
 *
 * @experimental Foundation API — the shape may change in a future minor release.
 */

import { listActions, showAction } from "../workflows/actions.js";
import { listWorkflows } from "../workflows/list.js";
import { showWorkflow } from "../workflows/show.js";
import { listRunEvents } from "../workflows/run-events.js";
import { startWorkflow } from "../workflows/start.js";
import { workflowStatus } from "../workflows/status.js";
import { advanceWorkflow } from "../workflows/advance.js";
import { approveGate, type ApproveGateOptions } from "../workflows/gate.js";
import { SdkHumanGateError } from "../workflows/errors.js";
import { cancelWorkflow } from "../workflows/cancel.js";
import { failWorkflow } from "../workflows/fail.js";
import { resumeWorkflow } from "../workflows/resume.js";
import { submitStageOutput } from "../workflows/stage-output.js";
import { runAction } from "../workflows/run-action.js";
import { adaptDryRun, adaptApply } from "../workflows/adapt.js";
import { writeProjection } from "../workflows/projection.js";
import type { Wiki } from "./types.js";
import type { WorkflowRun } from "../workflows/types.js";

/** The experimental workflow methods the `Wiki` facade composes in. */
export type WorkflowFacadeSlice = Pick<
  Wiki,
  | "listActions"
  | "showAction"
  | "listWorkflows"
  | "showWorkflow"
  | "listRunEvents"
  | "startWorkflow"
  | "workflowStatus"
  | "advanceWorkflow"
  | "approveGate"
  | "cancelWorkflow"
  | "failWorkflow"
  | "resumeWorkflow"
  | "submitStageOutput"
  | "runAction"
  | "adaptDryRun"
  | "adaptWorkflowRun"
  | "projectWorkflowRun"
>;

/**
 * The SDK-facing `approveGate`: a PROGRAMMATIC surface can NEVER satisfy a `human:`
 * gate (C1). A request for `actorKind:"human"` fails closed with
 * {@link SdkHumanGateError} BEFORE any lock/read — the human actor kind is producible
 * only by the interactive CLI proof. An `agent`/`system` actor passes through to the
 * core {@link approveGate} (whose `actorSatisfies` rule still rejects them on a human
 * gate as defense-in-depth).
 *
 * @param root - Normalized absolute project root.
 * @param runId - The run to approve a gate on.
 * @param gateId - The gate id to satisfy.
 * @param opts - The approving actor kind + optional label.
 * @returns The persisted run.
 * @throws {SdkHumanGateError} When `opts.actorKind` is `human`.
 */
function sdkApproveGate(root: string, runId: string, gateId: string, opts: ApproveGateOptions): Promise<WorkflowRun> {
  if (opts.actorKind === "human") throw new SdkHumanGateError(gateId);
  return approveGate(root, runId, gateId, opts);
}

/**
 * Build the experimental workflow slice of the `Wiki` facade bound to `root`.
 * Each method runs under the facade's quiet wrapper and delegates to the core
 * workflow operation. `startWorkflow` defaults `inputs` to `{}`.
 *
 * @param root - Normalized absolute project root.
 * @param runQuiet - The facade's quiet-scoping wrapper (output suppressed).
 * @returns The experimental workflow Wiki methods.
 */
export function buildWorkflowFacade(
  root: string,
  runQuiet: <T>(fn: () => Promise<T>) => Promise<T>,
): WorkflowFacadeSlice {
  return {
    listActions: () => runQuiet(() => listActions(root)),
    showAction: (actionId) => runQuiet(() => showAction(root, actionId)),
    listWorkflows: () => runQuiet(() => listWorkflows(root)),
    showWorkflow: (workflowId) => runQuiet(() => showWorkflow(root, workflowId)),
    listRunEvents: (runId) => runQuiet(() => listRunEvents(root, runId)),
    startWorkflow: (workflowId, inputs = {}) => runQuiet(() => startWorkflow(root, workflowId, inputs)),
    workflowStatus: (runId) => runQuiet(() => workflowStatus(root, runId)),
    advanceWorkflow: (runId) => runQuiet(() => advanceWorkflow(root, runId)),
    approveGate: (runId, gateId, opts) => runQuiet(() => sdkApproveGate(root, runId, gateId, opts)),
    cancelWorkflow: (runId) => runQuiet(() => cancelWorkflow(root, runId)),
    failWorkflow: (runId, detail) => runQuiet(() => failWorkflow(root, runId, detail)),
    resumeWorkflow: (runId) => runQuiet(() => resumeWorkflow(root, runId)),
    submitStageOutput: (runId, stageOutput) => runQuiet(() => submitStageOutput(root, runId, stageOutput)),
    runAction: (actionId, inputs = {}) => runQuiet(() => runAction(root, actionId, inputs, "sdk")),
    adaptDryRun: (runId) => runQuiet(() => adaptDryRun(root, runId)),
    adaptWorkflowRun: (runId, opts) => runQuiet(() => adaptApply(root, runId, opts)),
    projectWorkflowRun: (runId) => runQuiet(() => writeProjection(root, runId)),
  };
}
