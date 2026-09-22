/**
 * @file src/local-workflow-host/run-codec.ts
 * @description Shared local-run serialization limits and error identities; no filesystem access.
 */
import { MAX_WORKFLOW_RUN_BYTES } from "../utils/constants.js";
import type { WorkflowRun } from "../workflow-history/types.js";



/**
 * Raised when a run id that should already be slug-safe is not, on the WRITE
 * path. A typed error (not a generic `Error`) so callers can catch it distinctly.
 * The profile validator already rejects non-slug-safe workflow ids, so this is a
 * defensive last line.
 */
export class WorkflowRunIdError extends Error {
  constructor(message: string) {
    super(`workflow run id rejected: ${message}`);
    this.name = "WorkflowRunIdError";
  }
}



/**
 * Raised when a serialized run record would exceed {@link MAX_WORKFLOW_RUN_BYTES}
 * on the WRITE path. `readRun` rejects an oversize file, so writing one would
 * brick the run (unreadable forever); this fails the write CLOSED instead, with a
 * typed error callers can branch on. Thrown by {@link serializeRunWithinCap}
 * (used by `writeRun` and the stage-output preflight).
 */
export class WorkflowRunTooLargeError extends Error {
  constructor(
    /** The serialized record's byte length that breached the cap. */
    readonly bytes: number,
  ) {
    super(`workflow run record is too large: ${bytes} bytes exceeds the cap of ${MAX_WORKFLOW_RUN_BYTES}`);
    this.name = "WorkflowRunTooLargeError";
  }
}



/**
 * Serialize a run record to its on-disk JSON, FAILING CLOSED with
 * {@link WorkflowRunTooLargeError} when the result exceeds
 * {@link MAX_WORKFLOW_RUN_BYTES}. This is the SINGLE place run bytes are sized, so
 * the writer and the reader agree on the same ceiling — a record that serializes
 * within the cap here is guaranteed readable by {@link readRun} (which rejects an
 * oversize leaf), closing the asymmetric-cap (write-unbounded / read-capped) gap.
 *
 * @param run - The run record to serialize.
 * @returns The serialized JSON, guaranteed within the byte cap.
 * @throws {WorkflowRunTooLargeError} When the serialized record exceeds the cap.
 */
export function serializeRunWithinCap(run: WorkflowRun): string {
  const json = JSON.stringify(run);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_WORKFLOW_RUN_BYTES) throw new WorkflowRunTooLargeError(bytes);
  return json;
}
