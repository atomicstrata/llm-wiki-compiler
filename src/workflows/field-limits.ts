/**
 * @file src/workflows/field-limits.ts
 * @description Per-field WRITE-SIDE caps for caller-controlled run-record fields.
 *
 * A run record's overall size is bounded by `MAX_WORKFLOW_RUN_BYTES` on write
 * (via `serializeRunWithinCap`). These finer, per-field caps fail closed EARLY —
 * before a record is even built — with clear typed errors, so an oversized
 * free-form field (an actor label, a fail detail) is rejected at its entry point
 * rather than only when the whole serialized record happens to breach the byte
 * cap. They bound the few fields a caller writes verbatim onto an audit event.
 */

import { MAX_WORKFLOW_LABEL_CHARS, MAX_WORKFLOW_DETAIL_CHARS } from "../utils/constants.js";

/**
 * Raised when a caller-controlled, verbatim-recorded run-record field exceeds its
 * per-field character cap. Carries the field name + offending length so a caller
 * can branch and report precisely. Fails closed: nothing is written.
 */
export class WorkflowFieldTooLongError extends Error {
  constructor(
    /** The logical field name that exceeded its cap (e.g. `"actorLabel"`). */
    readonly field: string,
    /** The offending character length. */
    readonly length: number,
    /** The per-field character cap that was exceeded. */
    readonly cap: number,
  ) {
    super(`workflow ${field} is too long: ${length} chars exceeds the cap of ${cap}`);
    this.name = "WorkflowFieldTooLongError";
  }
}

/** Fail closed when `value` (if present) exceeds `cap` characters. */
function assertWithinCharCap(field: string, value: string | undefined, cap: number): void {
  if (value !== undefined && value.length > cap) {
    throw new WorkflowFieldTooLongError(field, value.length, cap);
  }
}

/**
 * Cap an optional actor LABEL at {@link MAX_WORKFLOW_LABEL_CHARS} (gate approve /
 * submit). The label lands verbatim on the audit event, so it is bounded before
 * the record is built. A missing label is fine.
 *
 * @param actorLabel - The caller-supplied label, if any.
 * @throws {WorkflowFieldTooLongError} When the label exceeds the cap.
 */
export function assertActorLabelWithinCap(actorLabel: string | undefined): void {
  assertWithinCharCap("actorLabel", actorLabel, MAX_WORKFLOW_LABEL_CHARS);
}

/**
 * Cap a `run-failed` DETAIL reason at {@link MAX_WORKFLOW_DETAIL_CHARS}. Recorded
 * verbatim on the event, so it is bounded before the record is built.
 *
 * @param detail - The caller-supplied fail reason.
 * @throws {WorkflowFieldTooLongError} When the detail exceeds the cap.
 */
export function assertDetailWithinCap(detail: string): void {
  assertWithinCharCap("detail", detail, MAX_WORKFLOW_DETAIL_CHARS);
}
