/**
 * @file src/local-workflows/run-events.ts
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

import type { LocalWorkflowHost } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { RunUnavailableError } from "./errors.js";
import type { WorkflowEvent } from "@atomicstrata/llmwiki-core/local-workflow-contracts";

/** Read retained events through host history without changing state. */
export async function listRunEventsWithHost(host: LocalWorkflowHost, root: string, runId: string): Promise<WorkflowEvent[]> {
  const read = await host.history.read(root, runId);
  if (read.status !== "ok") {
    throw new RunUnavailableError(runId, read.status === "absent" ? "absent" : read.detail);
  }
  return read.run.events;
}
