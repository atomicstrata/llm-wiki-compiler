/**
 * @file src/commands/operation/render.ts
 * @description Shared presentation + exit-code semantics for the `operation`
 * command group. Every recovery-drive seam returns an {@link OperationActionResult}
 * (state + counters + problems); these helpers render it faithfully for humans
 * and machines and map it to a house-standard exit code without ever inventing a
 * state transition of their own.
 */

import * as output from "../../utils/output.js";
import type { OperationActionResult } from "../../operation-bundles/executor.js";
import type { OperationRunState } from "../../operation-bundles/run-types.js";

/**
 * Terminal states that count as a SUCCESSFUL operator drive. A run still in an
 * unsettled state (applying/recovery-required/compensating) has not finished, and
 * a non-success terminal (failed/rejected/superseded/approval-invalidated/
 * abandoned) is reported but exits non-zero so scripts and CI never read it as OK.
 */
const DRIVE_SUCCESS_STATES: ReadonlySet<OperationRunState> = new Set([
  "succeeded",
  "succeeded-with-warnings",
  "compensated",
  "recovered",
  "cancelled",
]);

/** True when a drive result is a clean success (settled well, no problems). */
function isDriveSuccess(result: OperationActionResult): boolean {
  return (
    result.problems.length === 0 &&
    result.state !== undefined &&
    DRIVE_SUCCESS_STATES.has(result.state)
  );
}

/** Map a drive result to an exit code: 0 on clean success, 1 otherwise. */
export function driveExitCode(result: OperationActionResult): number {
  return isDriveSuccess(result) ? 0 : 1;
}

/** Emit a result as its verbatim JSON envelope on stdout. */
export function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Report a resolution/read/refusal failure on stderr and return exit code 1.
 * stderr is used (not output.status) so the message survives `--json` quiet mode
 * and never interleaves with a JSON envelope on stdout.
 */
export function reportFailure(message: string): number {
  console.error(`\x1b[31mError:\x1b[0m ${message}`);
  return 1;
}

/** The one-line summary of a drive result's identity and settled state. */
function driveLine(result: OperationActionResult, verb: string): string {
  return `${verb}: ${result.runId ?? result.bundleId} → ${result.state ?? "unresolved"}`;
}

/** Render one action result's identity, state, and any problems for humans. */
export function renderActionResult(result: OperationActionResult, verb: string): void {
  const success = isDriveSuccess(result);
  const text = driveLine(result, verb);
  output.status(success ? "✓" : "!", success ? output.success(text) : output.warn(text));
  renderProblems(result);
}

/** Render each bounded problem code on its own line. */
function renderProblems(result: OperationActionResult): void {
  for (const problem of result.problems) {
    output.status("!", output.error(`problem: ${problem.code} — ${problem.message}`));
  }
}
