/**
 * @file src/workflows/input-bounds.ts
 * @description RAW caller-input bounds shared by every workflow input surface.
 *
 * A workflow action's `inputs` are the one payload an UNTRUSTED caller fully
 * controls. {@link validateActionInputs} (in `action-input.ts`) type-checks and
 * per-field-bounds the NORMALIZED object, but two DoS classes must be refused
 * BEFORE the payload is parsed or materialized — they cannot wait for the typed
 * gate:
 *
 *  - a GIANT raw payload (a multi-MB `--input-json` string / MCP `inputs`) would
 *    be slurped + `JSON.parse`d into memory before any cap — a memory DoS;
 *  - a DEEPLY-NESTED object drives `JSON.stringify`/canonicalize into deep
 *    recursion that can OVERFLOW the stack — a crash-class DoS.
 *
 * These two pure guards ({@link assertRawInputJsonWithinBounds} for the raw CLI
 * string before `JSON.parse`, {@link assertInputDepthWithinBounds} for a parsed
 * object on any surface) fail CLOSED with {@link WorkflowInputBoundsError} so the
 * CLI exits non-zero and MCP returns a clean error result — never a crash.
 */

import { MAX_WORKFLOW_INPUTS_BYTES, MAX_WORKFLOW_INPUT_DEPTH } from "../utils/constants.js";

/**
 * Raised when a RAW caller-input payload breaches a pre-parse bound — its
 * serialized byte size exceeds {@link MAX_WORKFLOW_INPUTS_BYTES} or its nesting
 * depth exceeds {@link MAX_WORKFLOW_INPUT_DEPTH}. Carries a human-readable reason
 * so the CLI/MCP surfaces report a precise cause; the payload is never parsed or
 * materialized past the breach.
 */
export class WorkflowInputBoundsError extends Error {
  constructor(reason: string) {
    super(`workflow inputs rejected: ${reason}`);
    this.name = "WorkflowInputBoundsError";
  }
}

/**
 * Fail closed when a RAW `--input-json`/`inputs` JSON STRING exceeds the byte cap,
 * BEFORE `JSON.parse` — so an oversized payload is rejected before it is slurped
 * into a parsed structure (memory DoS). The byte length is the UTF-8 size of the
 * raw text the caller supplied.
 *
 * @param raw - The raw JSON text as received from the caller.
 * @throws {WorkflowInputBoundsError} When the raw text exceeds the byte cap.
 */
export function assertRawInputJsonWithinBounds(raw: string): void {
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > MAX_WORKFLOW_INPUTS_BYTES) {
    throw new WorkflowInputBoundsError(`raw payload of ${bytes} bytes exceeds the cap of ${MAX_WORKFLOW_INPUTS_BYTES}`);
  }
}

/**
 * Recursively measure object/array nesting, SHORT-CIRCUITING the moment `max` is
 * breached so a pathological structure cannot drive this check itself past the
 * stack. A scalar/`null` contributes depth 0; an object/array is one level deeper
 * than its deepest member.
 *
 * @param value - The value to measure.
 * @param max - The depth at which to stop and report a breach.
 * @param current - The depth accrued so far (internal recursion accumulator).
 * @returns True when nesting stays within `max`; false on the first breach.
 */
function isWithinDepth(value: unknown, max: number, current: number): boolean {
  if (current > max) return false;
  if (value === null || typeof value !== "object") return true;
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (!isWithinDepth(child, max, current + 1)) return false;
  }
  return true;
}

/**
 * Fail closed when a PARSED caller-input object nests deeper than
 * {@link MAX_WORKFLOW_INPUT_DEPTH} — a guard against the stack-overflow class a
 * later `JSON.stringify`/canonicalize would hit. Surface-agnostic: the CLI calls
 * it after `JSON.parse`, the MCP handler on the already-parsed `inputs`.
 *
 * @param inputs - The parsed caller-input object.
 * @throws {WorkflowInputBoundsError} When nesting exceeds the depth cap.
 */
export function assertInputDepthWithinBounds(inputs: Record<string, unknown>): void {
  if (!isWithinDepth(inputs, MAX_WORKFLOW_INPUT_DEPTH, 0)) {
    throw new WorkflowInputBoundsError(`nesting deeper than the cap of ${MAX_WORKFLOW_INPUT_DEPTH}`);
  }
}
