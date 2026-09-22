/**
 * @file src/commands/operation/drive.ts
 * @description `llmwiki operation resume` and `operation compensate` — the two
 * operator recovery-drive commands. Both acquire the project lock under the
 * `recovery` intent (which owns the re-drive and so bypasses the recovery gate),
 * route through the existing locked seams, faithfully report the resulting
 * {@link OperationActionResult}, and release the lock in a `finally`.
 *
 * MILESTONE-A AUTHORITY: the production runtime carries the refusing authority
 * provider (no declarative operations-authority resolver ships yet), so every
 * drive recomputes authority, finds none, and fails closed — resume re-refuses
 * with the run left parked, compensate parks without reverting. That refusal is
 * surfaced verbatim (state + problem, non-zero exit), never papered over.
 */

import { releaseLock } from "../../utils/lock.js";
import { acquireMutationLock } from "../../operation-bundles/lock-gate.js";
import { recoverOperationRunLocked, resumeOperationRecoveryLocked } from "../../operation-bundles/recovery.js";
import { compensateOperationBundleLocked, type CompensationTrigger } from "../../operation-bundles/compensation.js";
import { readCancelRequest } from "../../operation-bundles/cancel-request.js";
import type { OperationActionResult } from "../../operation-bundles/executor.js";
import {
  buildDriveRequest, loadOperationInventory, readKeyEpoch, readRunForTarget, resolveTarget,
  type ResolvedTarget,
} from "./resolve.js";
import { driveExitCode, emitJson, renderActionResult, reportFailure } from "./render.js";

/** CLI options shared by the recovery-drive commands. */
export interface OperationDriveOptions {
  /** Emit the machine-readable action envelope instead of the human summary. */
  json?: boolean;
}

/** One recovery-drive action over a resolved target under the held lock. */
type DriveAction = (resolved: ResolvedTarget) => Promise<OperationActionResult>;

/** Run one action under the recovery-intent project lock, or report a busy lock. */
async function underRecoveryLock(root: string, action: () => Promise<OperationActionResult>): Promise<OperationActionResult | "lock-busy"> {
  const acquired = await acquireMutationLock(root, "recovery");
  if (!acquired) return "lock-busy";
  try {
    return await action();
  } finally {
    await releaseLock(root);
  }
}

/** The machine-readable envelope for one drive result. */
function driveEnvelope(result: OperationActionResult): Record<string, unknown> {
  return { bundleId: result.bundleId, runId: result.runId, state: result.state, counters: result.counters, problems: result.problems };
}

/** Resolve the target, drive it under the lock, and render/emit the result. */
async function runDrive(root: string, target: string, verb: string, json: boolean | undefined, action: DriveAction): Promise<number> {
  const inventory = await loadOperationInventory(root);
  const resolved = resolveTarget(inventory, target);
  if (resolved === null) return reportFailure(`No operation bundle or run matches "${target}".`);
  const result = await underRecoveryLock(root, () => action(resolved));
  if (result === "lock-busy") return reportFailure("Another llmwiki process is using this project; not driving recovery.");
  if (json) emitJson(driveEnvelope(result));
  else renderActionResult(result, verb);
  return driveExitCode(result);
}

/** True when the resolved target's run is a crash-interrupted `applying` run. */
async function isApplyingRun(root: string, resolved: ResolvedTarget): Promise<boolean> {
  const keyEpochId = await readKeyEpoch(root);
  if (keyEpochId === null) return false;
  const read = await readRunForTarget(root, resolved, keyEpochId);
  return read.status === "ok" && read.run.state === "applying";
}

/**
 * Resume drive: a crash-interrupted `applying` run is re-driven by observation
 * ({@link recoverOperationRunLocked}); any other run is treated as an explicit
 * operator resume of a parked `recovery-required` run ({@link resumeOperationRecoveryLocked}),
 * which itself refuses a run that is not parked.
 */
async function resumeAction(root: string, resolved: ResolvedTarget): Promise<OperationActionResult> {
  const request = buildDriveRequest(resolved, ["operation-bundle.approve"]);
  return (await isApplyingRun(root, resolved))
    ? recoverOperationRunLocked(root, request)
    : resumeOperationRecoveryLocked(root, request);
}

/** Compensate drive: a pending cancel advisory selects the cancellation trigger. */
async function compensateAction(root: string, resolved: ResolvedTarget): Promise<OperationActionResult> {
  const cancel = await readCancelRequest(root, resolved.workspaceId, resolved.runId);
  const trigger: CompensationTrigger = cancel.status === "present" ? "cancellation" : "apply-failure";
  return compensateOperationBundleLocked(root, buildDriveRequest(resolved, ["operation-bundle.approve"]), trigger);
}

/**
 * Resume a parked (or crash-interrupted) operation run toward settlement.
 *
 * @param root - The project root.
 * @param target - A run id or bundle id.
 * @param options - `--json` toggles the machine-readable envelope.
 * @returns 0 on a clean settlement, 1 on refusal/park/problems.
 */
export function operationResumeCommand(root: string, target: string, options: OperationDriveOptions = {}): Promise<number> {
  return runDrive(root, target, "resume", options.json, (resolved) => resumeAction(root, resolved));
}

/**
 * Compensate an operation run's applied effects under the closed eligibility rule.
 *
 * @param root - The project root.
 * @param target - A run id or bundle id.
 * @param options - `--json` toggles the machine-readable envelope.
 * @returns 0 on a clean compensation, 1 on refusal/park/problems.
 */
export function operationCompensateCommand(root: string, target: string, options: OperationDriveOptions = {}): Promise<number> {
  return runDrive(root, target, "compensate", options.json, (resolved) => compensateAction(root, resolved));
}
