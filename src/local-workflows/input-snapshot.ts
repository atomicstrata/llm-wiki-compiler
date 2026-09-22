/**
 * Engine-owned implementation; legacy imports forward to this module.
 * Capture legacy workflow inputs using their durable JSON representation before
 * asynchronous work. JSON hooks remain supported; hidden properties stay hidden.
 * Bound both the original tree and hook-produced values, and reject non-finite
 * numbers before JSON can silently turn an integrity refusal into a null value.
 */
import { MAX_WORKFLOW_INPUTS_BYTES, MAX_WORKFLOW_INPUT_DEPTH } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { assertInputDepthWithinBounds, WorkflowInputBoundsError } from "./input-bounds.js";

/** The public start-input byte-cap error, retained at its original export path. */
export class WorkflowInputsTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`workflow inputs are too large: ${bytes} bytes exceeds the cap of ${MAX_WORKFLOW_INPUTS_BYTES}`);
    this.name = "WorkflowInputsTooLargeError";
  }
}

/** Bound values returned by toJSON/getters without traversing those hooks twice. */
function snapshotReplacer(): (this: object, key: string, value: unknown) => unknown {
  const depths = new WeakMap<object, number>();
  return function (_key, value) {
    const depth = depths.has(this) ? depths.get(this)! + 1 : 0;
    if (depth > MAX_WORKFLOW_INPUT_DEPTH) {
      throw new WorkflowInputBoundsError(`nesting deeper than the cap of ${MAX_WORKFLOW_INPUT_DEPTH}`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(Number.isNaN(value) ? "NaN is not allowed" : "Infinity is not allowed");
    }
    if (value !== null && typeof value === "object") depths.set(value, depth);
    return value;
  };
}

/** Snapshot once before awaiting; later validation and writes use only this copy. */
export function snapshotWorkflowInputs(inputs: Record<string, unknown>): Record<string, unknown> {
  assertInputDepthWithinBounds(inputs);
  const json = JSON.stringify(inputs, snapshotReplacer());
  if (json === undefined) throw new WorkflowInputBoundsError("inputs must serialize to an object");
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_WORKFLOW_INPUTS_BYTES) throw new WorkflowInputsTooLargeError(bytes);
  const snapshot: unknown = JSON.parse(json);
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new WorkflowInputBoundsError("inputs must serialize to an object");
  }
  return snapshot as Record<string, unknown>;
}
