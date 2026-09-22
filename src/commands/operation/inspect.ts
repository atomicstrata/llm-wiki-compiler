/**
 * @file src/commands/operation/inspect.ts
 * @description `llmwiki operation inspect <target>` — one run's full state: state,
 * counters, per-mutation/compensation/projection outcomes, completion warnings,
 * notices, residual findings, and any pending cancel advisory. Read-only; exits
 * non-zero only when the target cannot be resolved or its run leaf is unreadable.
 */

import * as output from "../../utils/output.js";
import { readCancelRequest, type CancelRequestRead } from "../../operation-bundles/cancel-request.js";
import type { OperationRun } from "../../operation-bundles/run-types.js";
import { resolveTargetRun } from "./resolve.js";
import { emitJson, reportFailure } from "./render.js";

/** CLI options for `operation inspect`. */
export interface OperationInspectOptions {
  /** Emit the machine-readable run envelope instead of the human summary. */
  json?: boolean;
}

/** A run's outcome collections, flattened for the JSON envelope. */
function runEnvelope(run: OperationRun, cancel: CancelRequestRead): Record<string, unknown> {
  return {
    workspaceId: run.workspaceId, bundleId: run.bundleId, runId: run.runId,
    state: run.state, stateVersion: run.stateVersion, counters: run.counters,
    mutationOutcomes: run.mutationOutcomes, compensationOutcomes: run.compensationOutcomes,
    projectionOutcomes: run.projectionOutcomes, completionWarnings: run.completionWarnings,
    notices: run.notices, residualFindings: run.residualFindings,
    cancel: cancel.status === "present" ? { status: "present", requester: cancel.request.requester, at: cancel.request.at } : { status: cancel.status },
  };
}

/** Render the counters and per-kind outcome tallies. */
function renderOutcomes(run: OperationRun): void {
  const c = run.counters;
  output.status("i", output.info(`Mutations: ${c.mutations.applied}/${c.mutations.attempted} applied, ${c.mutations.skipped} skipped, ${c.mutations.failed} failed`));
  output.status("i", output.info(`Compensations: ${c.compensations.completed}/${c.compensations.attempted} completed, ${c.compensations.failed} failed`));
  output.status("i", output.info(`Projections: ${c.projections.applied}/${c.projections.attempted} applied, ${c.projections.failed} failed`));
  for (const outcome of run.mutationOutcomes) {
    output.status("~", output.dim(`  mutation ${outcome.mutationId} → ${outcome.status}`));
  }
}

/** Render completion warnings, notices, and residual findings. */
function renderRunAnnotations(run: OperationRun): void {
  for (const warning of run.completionWarnings) output.status("!", output.warn(`warning: ${warning.code}`));
  for (const notice of run.notices) output.status("i", output.dim(`notice: ${notice.code}`));
  for (const finding of run.residualFindings) output.status("!", output.warn(`residual: ${finding.code}`));
}

/** Render the pending cancel advisory line, if any. */
function renderCancelLine(cancel: CancelRequestRead): void {
  if (cancel.status === "present") output.status("~", output.info(`Cancel advisory: pending (requester=${cancel.request.requester})`));
  else if (cancel.status === "unavailable") output.status("!", output.warn(`Cancel advisory: unreadable (${cancel.detail})`));
}

/** Render the full human summary for one run. */
function renderHuman(run: OperationRun, cancel: CancelRequestRead): void {
  output.header(`operation ${run.runId}`);
  output.status("i", output.info(`Bundle: ${run.bundleId}  Workspace: ${run.workspaceId}`));
  output.status("i", output.info(`State: ${run.state} (v${run.stateVersion})`));
  renderOutcomes(run);
  renderRunAnnotations(run);
  renderCancelLine(cancel);
}

/**
 * Inspect one operation run by run id or bundle id.
 *
 * @param root - The project root to inspect.
 * @param target - A run id or bundle id.
 * @param options - `--json` toggles the machine-readable envelope.
 * @returns 0 on a successful read, 1 when the target is unknown/unreadable.
 */
export async function operationInspectCommand(root: string, target: string, options: OperationInspectOptions = {}): Promise<number> {
  const outcome = await resolveTargetRun(root, target);
  if ("error" in outcome) return reportFailure(outcome.error);
  const cancel = await readCancelRequest(root, outcome.resolved.workspaceId, outcome.resolved.runId);
  if (options.json) emitJson(runEnvelope(outcome.run, cancel));
  else renderHuman(outcome.run, cancel);
  return 0;
}
