/**
 * Read-only `/api/workflow-runs` projection for the viewer.
 *
 * Workflow runs live under `.llmwiki/workflows/runs/` — NOT in the frozen
 * `ViewerSnapshot` — so this surface reads them at REQUEST time via
 * `workflowStatus(root)`, the same read-only, fail-visible classifier the
 * `workflow status` CLI uses. It NEVER mutates run state (no write/advance),
 * and an unavailable/corrupt run store is surfaced as a `problem` row rather
 * than reported as an empty list, so a broken store never reads as clean.
 *
 * The mapping deliberately exposes ONLY status fields (runId, classification,
 * status, currentStage, workflow, problem, awaiting-* flags) — never the
 * machine-local run-file paths or any other internal record detail.
 */

import type { RunStatus } from "../workflows/status.js";

/** A single stable JSON row in the `/api/workflow-runs` envelope. */
export interface WorkflowRunRow {
  /** The run id this row reports on. */
  runId: string;
  /** How the run relates to the active profile config. */
  classification: string;
  /** Lifecycle status (e.g. `pending`/`running`/`completed`); absent for a problem row. */
  status?: string;
  /** The run's current stage id, or `null` when none; absent for a problem row. */
  currentStage?: string | null;
  /** The workflow id the run belongs to; absent for a problem row. */
  workflow?: string;
  /** Why the run/store is unavailable or malformed; present only on a problem row. */
  problem?: string;
  /** Gate id the current stage is parked on, when awaiting a `gate approve`. */
  awaitingGate?: string;
  /** True when the current stage is parked needing a stage-output `submit`. */
  awaitingOutput?: boolean;
}

/**
 * Map one classifier {@link RunStatus} to its stable JSON row. Status-only:
 * the readable run's lifecycle fields are projected when present, and nothing
 * beyond the status fields (no file paths, no raw record) is ever exposed.
 */
function toRunRow(status: RunStatus): WorkflowRunRow {
  const row: WorkflowRunRow = { runId: status.runId, classification: status.classification };
  if (status.run !== undefined) {
    row.status = status.run.status;
    row.currentStage = status.run.currentStage;
    row.workflow = status.run.workflowId;
  }
  if (status.problem !== undefined) row.problem = status.problem;
  if (status.awaitingGate !== undefined) row.awaitingGate = status.awaitingGate;
  if (status.awaitingOutput === true) row.awaitingOutput = true;
  return row;
}

/**
 * Project a classifier `RunStatus[]` into the `/api/workflow-runs` envelope.
 * Pure (no I/O) so the route handler stays a thin read-and-serialize.
 *
 * @param statuses - Per-run classifications from `workflowStatus(root)`.
 * @returns The `{ runs }` envelope body, one row per status (preserving order).
 */
export function buildWorkflowRunsEnvelope(statuses: RunStatus[]): { runs: WorkflowRunRow[] } {
  return { runs: statuses.map(toRunRow) };
}
