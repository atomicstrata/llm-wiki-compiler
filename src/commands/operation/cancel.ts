/**
 * @file src/commands/operation/cancel.ts
 * @description `llmwiki operation cancel <target>` — write the lock-free advisory
 * cancellation request (design v2 section 18). The advisory is create-only and
 * non-authoritative: it never settles state itself; a later lock holder observes
 * it and appends the signed cancellation transition. The command reports
 * `created` or `exists` and refuses (non-zero) only when the run has already
 * reached a terminal state, where a cancel advisory can never take effect.
 */

import * as output from "../../utils/output.js";
import { writeCancelRequestLockFree } from "../../operation-bundles/cancel-request.js";
import type { OperationRunState } from "../../operation-bundles/run-types.js";
import { resolveTargetRun, type ResolvedTarget } from "./resolve.js";
import { CLI_OPERATOR_ID } from "../../cli/shared.js";
import { emitJson, reportFailure } from "./render.js";

/** CLI options for `operation cancel`. */
export interface OperationCancelOptions {
  /** Emit the machine-readable envelope instead of the human line. */
  json?: boolean;
}

/**
 * Run states where cancellation is still meaningful: pre-effect approval states
 * plus the live unsettled states. Every other (terminal) state cannot be affected
 * by an advisory, so the command refuses rather than write dead bytes.
 */
const CANCELLABLE_RUN_STATES: ReadonlySet<OperationRunState> = new Set([
  "awaiting-approval", "approved", "applying", "recovery-required", "compensating",
]);

/** Report the created/exists outcome for humans or machines. */
function reportOutcome(outcome: "created" | "exists", resolved: ResolvedTarget, json: boolean | undefined): void {
  if (json) {
    emitJson({ workspaceId: resolved.workspaceId, bundleId: resolved.bundleId, runId: resolved.runId, cancel: outcome });
    return;
  }
  const line = `Cancel advisory ${outcome} for run ${resolved.runId}.`;
  output.status(outcome === "created" ? "✓" : "i", outcome === "created" ? output.success(line) : output.info(line));
}

/**
 * Write the advisory cancellation request for a run by run id or bundle id.
 *
 * @param root - The project root.
 * @param target - A run id or bundle id.
 * @param options - `--json` toggles the machine-readable envelope.
 * @returns 0 when the advisory is present (created or already existed), 1 when the
 *   target is unknown/unreadable or the run is already terminal.
 */
export async function operationCancelCommand(root: string, target: string, options: OperationCancelOptions = {}): Promise<number> {
  const target_ = await resolveTargetRun(root, target);
  if ("error" in target_) return reportFailure(target_.error);
  const { resolved, run } = target_;
  if (!CANCELLABLE_RUN_STATES.has(run.state)) {
    return reportFailure(`Run ${resolved.runId} is ${run.state}; a cancel advisory cannot take effect.`);
  }
  const outcome = await writeCancelRequestLockFree(root, {
    workspaceId: resolved.workspaceId, runId: resolved.runId, requester: CLI_OPERATOR_ID, at: new Date().toISOString(),
  });
  reportOutcome(outcome, resolved, options.json);
  return 0;
}
