/**
 * Engine-owned implementation; legacy imports forward to this module.
 * Detach the legacy action schema's scalar/string-array inputs before awaiting
 * profile loading. Unlike free-form start inputs, actions validate JavaScript
 * types before JSON conversion: a Date must not become an accepted string, and
 * an unknown undefined field must not disappear before unknown-key validation.
 */
import { assertInputDepthWithinBounds, WorkflowInputBoundsError } from "./input-bounds.js";
import { ActionInputError } from "./errors.js";

/** Objects cannot match any action field; retain that fact without caller aliases. */
function detachField(value: unknown): unknown {
  if (Array.isArray(value)) return Array.from(value, (item) =>
    item !== null && typeof item === "object" ? Object.freeze({}) : item);
  return value !== null && typeof value === "object" ? Object.freeze({}) : value;
}

/** Capture enumerable fields while retaining undefined/invalid types for validation. */
export function captureActionInputValues(actionId: string, inputs: Record<string, unknown>): Record<string, unknown> {
  try {
    assertInputDepthWithinBounds(inputs);
  } catch (error) {
    if (error instanceof WorkflowInputBoundsError) throw new ActionInputError(actionId, error.message);
    throw error;
  }
  const captured = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(inputs)) captured[key] = detachField(inputs[key]);
  return captured;
}
