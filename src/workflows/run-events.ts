/**
 * @file src/workflows/run-events.ts
 * @description The read-only `events` operation over ONE run's audit trail.
 *
 * A {@link WorkflowRun} carries an append-only `events[]` audit trail (genesis
 * `workflow-start`, then each `stage-advanced`/`gate-approved`/`stage-output`/…).
 * Until now those events were viewable ONLY by cat-ing the private run JSON. This
 * surfaces them through a read-only operation so `workflow events <run>` (CLI +
 * SDK `listRunEvents`) exposes the audit trail without touching run state.
 *
 * Read-only and fail-visible: it reads the run fail-closed via {@link readRun}, so
 * an absent/unavailable/unknown run is a {@link RunUnavailableError} (nonzero/throw)
 * rather than a silent empty list. Reads are intentionally NOT owner-gated — the
 * audit trail is observability, and a cross-owner READ is permitted (mirroring the
 * by-id `status` read), while every MUTATION stays owner-gated elsewhere.
 */

import { readRun } from "./store.js";
import { RunUnavailableError } from "./errors.js";
import type { WorkflowEvent } from "./types.js";

/**
 * List the recorded audit events for one run, in append order.
 *
 * Reads the run fail-closed: an absent run, an unavailable/corrupt record, or an
 * unknown id throws {@link RunUnavailableError} so the caller sees a fail-visible
 * problem rather than an empty trail. The returned events are the run's
 * `events[]` exactly as recorded (type/at/actorKind/actorLabel/stageId/gateId/
 * decision/detail/stateVersionBefore/After). Read-only: no lock, no write.
 *
 * @param root - Absolute project root.
 * @param runId - The run id whose audit trail to read.
 * @returns The run's recorded events, in append order.
 * @throws {RunUnavailableError} When the run is absent/unavailable/unknown.
 */
export async function listRunEvents(root: string, runId: string): Promise<WorkflowEvent[]> {
  const read = await readRun(root, runId);
  if (read.status !== "ok") {
    throw new RunUnavailableError(runId, read.status === "absent" ? "absent" : read.detail);
  }
  return read.run.events;
}
