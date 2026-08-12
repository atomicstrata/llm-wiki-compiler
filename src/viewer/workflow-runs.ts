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
 * status, currentStage, workflow, problem, awaiting-* flags, and the classifier's
 * declared submit-type hints) — never the machine-local run-file paths or any
 * other internal record detail. The two `nextSubmit*` hints are profile-DECLARED
 * type ids, the same vocabulary `/api/pages` already projects for BROWSE; they
 * carry no instance data and no path.
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
  /**
   * True when the `awaitingGate` above is a `trust:` gate — one `gate approve`
   * CANNOT clear. Carried so the renderer hints the trusted-write grant plus a
   * re-submit rather than a `gate approve` that would throw `TrustGateNotHereError`.
   */
  awaitingTrustGate?: boolean;
  /** True when the current stage is parked needing a stage-output `submit`. */
  awaitingOutput?: boolean;
  /**
   * A DECLARED write entity type of the current stage — a valid `--entity-type`
   * for the submit hint. Present only alongside {@link awaitingOutput}.
   */
  nextSubmitEntityType?: string;
  /**
   * A DECLARED artifact type of the current stage — a valid `--artifact-type`
   * for the submit hint. Present only alongside {@link awaitingOutput}, and
   * independent of {@link nextSubmitEntityType}.
   */
  nextSubmitArtifactType?: string;
}

/**
 * Copy the park-related hints onto `row`, mirroring `applyParkHints` in
 * `src/workflows/status.ts` field-for-field.
 *
 * The classifier sets these so a renderer can name a command that WORKS, and a
 * renderer that receives only half of them names one that does not: a submit
 * without its declared type prints a `workflow submit` missing the `--kind`
 * `buildStageOutput` requires first, and a gate without `awaitingTrustGate`
 * prints a `gate approve` that `vouchGate` refuses on a `trust:` gate. So the
 * hint fields travel together or the row misinstructs.
 */
function copyParkHints(row: WorkflowRunRow, status: RunStatus): void {
  if (status.awaitingGate !== undefined) row.awaitingGate = status.awaitingGate;
  if (status.awaitingTrustGate === true) row.awaitingTrustGate = true;
  if (status.awaitingOutput !== true) return;
  row.awaitingOutput = true;
  if (status.nextSubmitEntityType !== undefined) row.nextSubmitEntityType = status.nextSubmitEntityType;
  if (status.nextSubmitArtifactType !== undefined) row.nextSubmitArtifactType = status.nextSubmitArtifactType;
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
  copyParkHints(row, status);
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
