/**
 * @file src/linter/workflow-run-rule.ts
 * @description The `workflow-run-health` lint rule. SURFACES malformed/blocked/
 * stuck workflow runs through `llmwiki lint` (and the `lint_wiki` MCP tool / SDK
 * `lint`), so a project never reads clean while a run is broken or stuck.
 *
 * The spec says malformed run state is surfaced by `status`/LINT; `status` already
 * fails-visible, and this is the LINT half. It reads the runs via the read-only,
 * fail-visible {@link workflowStatus} and emits a finding for each run that is:
 *  - `blocked-by-config` — it sits on a stage the active def no longer declares (or
 *    is an unavailable/unknown run record);
 *  - `needs-adaptation` — its def changed and it needs `workflow adapt`;
 *  - carrying a `problem` — an unavailable/corrupt/integrity-failed record.
 *
 * Read-only: it emits diagnostics only, never repairs a run. A default project (no
 * `workflows`, no runs) yields ZERO findings, so the default lint output stays
 * byte-identical (parity-safe).
 */

import { workflowStatus, type RunStatus } from "../workflows/status.js";
import { LLMWIKI_DIR } from "../utils/constants.js";
import type { LintResult } from "./types.js";

/** Project-relative path the workflow-run findings point at (the private run dir). */
const RUNS_REL_PATH = `${LLMWIKI_DIR}/workflows/runs`;

/** Run classifications a lint finding is emitted for (broken/stuck under config). */
const FLAGGED_CLASSIFICATIONS: ReadonlySet<RunStatus["classification"]> = new Set([
  "blocked-by-config",
  "needs-adaptation",
]);

/** True when a run status warrants a lint finding (a problem, or a flagged classification). */
function isFlagged(status: RunStatus): boolean {
  return status.problem !== undefined || FLAGGED_CLASSIFICATIONS.has(status.classification);
}

/** The stable warning-code-prefixed message for one flagged run. */
function messageFor(status: RunStatus): string {
  if (status.problem !== undefined) return `run-problem: ${status.runId}: ${status.problem}`;
  return `run-${status.classification}: ${status.runId} (run \`llmwiki workflow status ${status.runId}\`)`;
}

/** Map one flagged run status to a `workflow-run-health` lint warning. */
function toFinding(status: RunStatus): LintResult {
  return { rule: "workflow-run-health", severity: "warning", file: RUNS_REL_PATH, message: messageFor(status) };
}

/**
 * Emit a `workflow-run-health` warning for each broken/stuck/malformed workflow
 * run. Loads the runs via the fail-visible {@link workflowStatus}; a healthy/current
 * run (and a project with NO runs) yields nothing, so the default lint output stays
 * byte-identical (parity-safe).
 *
 * @param root - Absolute path to the project root directory.
 * @returns One warning per flagged run; empty when every run is healthy / none exist.
 */
export async function checkWorkflowRunHealth(root: string): Promise<LintResult[]> {
  const statuses = await workflowStatus(root);
  return statuses.filter(isFlagged).map(toFinding);
}
