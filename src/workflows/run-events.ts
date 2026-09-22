/**
 * Standard-distribution compatibility entry points for run-events.
 * Host construction stays here; optional engine operations receive a host.
 */
export { listRunEventsWithHost } from "@atomicstrata/llmwiki-local-workflows";
import { listRunEventsWithHost } from "@atomicstrata/llmwiki-local-workflows";
import { createLocalWorkflowHost } from "./host.js";
import type { WorkflowEvent } from "@atomicstrata/llmwiki-core/local-workflow-contracts";


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
  return listRunEventsWithHost(createLocalWorkflowHost(), root, runId);
}
