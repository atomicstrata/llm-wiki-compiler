/**
 * @file src/connectors/input-validation.ts
 * @description Runtime connector-input contract validation. JavaScript and SDK
 * callers can bypass TypeScript shapes, so every key and value is checked and
 * byte-bounded before candidate, rate-limit, audit, or network work begins.
 */

import { MAX_CONNECTOR_INPUT_BYTES } from "./audit.js";
import { captureOwnDataRecord, RuntimeCaptureError } from "../utils/runtime-capture.js";
import { isWellFormedUnicode } from "../utils/well-formed-unicode.js";

/** Fixed refusal returned by the connector input boundary. */
export interface ConnectorInputRefusal {
  kind: "refused";
  reason: string;
}

/** Successful capture of the only connector-input object the run may use. */
export interface ConnectorInputCapture {
  kind: "ok";
  inputs: Readonly<Record<string, string>>;
}

/** Fixed nonreflecting reason for a structurally hostile input object. */
const INVALID_INPUTS = "connector inputs are invalid";

/** Capture one exact primitive input value with all runtime bounds enforced. */
function captureInputValue(key: string, value: unknown): string | ConnectorInputRefusal {
  if (typeof value !== "string") {
    return { kind: "refused", reason: `connector input ${key} must be a string` };
  }
  if (value.length === 0) return { kind: "refused", reason: `connector input ${key} is empty` };
  if (value.length > MAX_CONNECTOR_INPUT_BYTES) {
    return { kind: "refused", reason: `connector input ${key} exceeds ${MAX_CONNECTOR_INPUT_BYTES} bytes` };
  }
  if (!isWellFormedUnicode(value)) return { kind: "refused", reason: INVALID_INPUTS };
  if (Buffer.byteLength(value, "utf8") > MAX_CONNECTOR_INPUT_BYTES) {
    return { kind: "refused", reason: `connector input ${key} exceeds ${MAX_CONNECTOR_INPUT_BYTES} bytes` };
  }
  return value;
}

/** Capture the exact declared input record without invoking caller code. */
export function captureConnectorInputs(
  required: readonly string[],
  value: unknown,
): ConnectorInputCapture | ConnectorInputRefusal {
  let record: Readonly<Record<string, unknown>>;
  try {
    record = captureOwnDataRecord(value);
  } catch (error) {
    if (error instanceof RuntimeCaptureError) return { kind: "refused", reason: INVALID_INPUTS };
    throw error;
  }
  const inputs = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(record)) {
    if (!required.includes(key)) return { kind: "refused", reason: `unknown connector input: ${key}` };
    const captured = captureInputValue(key, record[key]);
    if (typeof captured !== "string") return captured;
    inputs[key] = captured;
  }
  for (const key of required) {
    if (!Object.hasOwn(inputs, key)) return { kind: "refused", reason: `missing connector input: ${key}` };
  }
  return { kind: "ok", inputs: Object.freeze(inputs) };
}
