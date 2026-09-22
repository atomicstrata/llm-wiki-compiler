/**
 * @file src/operation-bundles/recovery.ts
 * @description Forward-first crash recovery by observation. For a run left in
 * `applying` by a crash, it rechecks the recorded authority snapshot (drift parks
 * with bounded evidence and never auto-compensates), then re-drives the shared
 * settle-to-terminal coordinator: every started-without-outcome mutation is
 * settled from its current on-disk state, any not-yet-started mutation is applied
 * forward, partial projections are regenerated, and the run reaches a terminal
 * state. `resumeOperationRecoveryLocked` is the explicit operator resume: it
 * requires the exact manifest digest, the approve grant, and unchanged recorded
 * authority before it moves a `recovery-required` run back into `applying`.
 */

import { currentApplyOwner } from "./apply-owner.js";
import {
  appendRunStep, computeAuthoritySnapshot, loadApprovedAction, loadRunSession, runResult, settleToTerminal,
  type ApproveOperationBundleRequest, type OperationActionResult, type RunSession,
} from "./executor.js";
import type { OperationRun } from "./run-types.js";

/**
 * Drive an `applying` run to settlement by observation. The recorded authority is
 * rechecked first: drift or an unavailable provider parks at recovery-required
 * without touching any effect.
 */
async function driveRecovery(session: RunSession, run: OperationRun): Promise<OperationActionResult> {
  const apply = await computeAuthoritySnapshot(session);
  if (apply.status !== "ok" || apply.digest !== run.authoritySnapshotDigest) {
    return runResult(await appendRunStep(session, run, { kind: "recovery-required", code: "bundle-recovery-required" }), "bundle-recovery-required");
  }
  return settleToTerminal(session, apply.snapshot, run);
}

/**
 * Recover one specific bundle's run under the held lock. Only an `applying` run
 * (a crash window) is driven forward; a terminal or non-applying run is returned
 * unchanged. The caller establishes that the prior owner is not live.
 */
export async function recoverOperationRunLocked(root: string, request: ApproveOperationBundleRequest): Promise<OperationActionResult> {
  const loaded = await loadRunSession(root, request);
  if (loaded.status === "problem") return loaded.result;
  const { session, run } = loaded;
  if (run.state !== "applying") return runResult(run);
  return driveRecovery(session, run);
}

/**
 * Explicit operator resume of a `recovery-required` run. Requires the approve
 * grant and unchanged recorded authority, moves the run back into `applying`
 * through recovery-resumed, then re-drives the same observation coordinator.
 */
export async function resumeOperationRecoveryLocked(root: string, request: ApproveOperationBundleRequest): Promise<OperationActionResult> {
  const loaded = await loadApprovedAction(root, request, "recovery-required");
  if (loaded.status === "stop") return loaded.result;
  const { session } = loaded;
  let run = loaded.run;
  const apply = await computeAuthoritySnapshot(session);
  if (apply.status !== "ok") return runResult(run, "review-store-unavailable");
  if (apply.digest !== run.authoritySnapshotDigest) return runResult(run, "approval-invalidated");
  run = await appendRunStep(session, run, { kind: "recovery-resumed", authoritySnapshotDigest: apply.digest, applyOwner: currentApplyOwner() });
  return driveRecovery(session, run);
}
