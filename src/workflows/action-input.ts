/**
 * @file src/workflows/action-input.ts
 * @description PURE validation of a workflow action's caller inputs against its
 * declared `inputSchema`.
 *
 * {@link validateActionInputs} is the fail-closed gate between an untrusted
 * caller payload and the run-lifecycle dispatch: it accepts ONLY keys the action
 * declares (an action with no `inputSchema` accepts NO inputs), enforces each
 * field's `required`/`default` and runtime type, and re-validates an `entityRef`
 * value through {@link parseEntityId} so a malformed or out-of-scope id is refused
 * BEFORE any authority check or I/O. It returns the normalized inputs (declared
 * keys only, defaults applied). No I/O, no side effects — pure input arithmetic.
 *
 * Type contract per declared field `type`:
 *  - `string` / `entityRef` → a string (an `entityRef` is ADDITIONALLY parsed and
 *    its `entityType` must be one of the field's declared `entityTypes`);
 *  - `number` → a FINITE number (NaN/Infinity rejected);
 *  - `boolean` → a boolean;
 *  - `string[]` → an array whose every element is a string.
 */

import { parseEntityId } from "../profile/identity.js";
import { ActionInputError } from "./errors.js";
import {
  MAX_WORKFLOW_INPUTS_BYTES,
  MAX_WORKFLOW_INPUT_STRING_CHARS,
  MAX_WORKFLOW_INPUT_ARRAY_ITEMS,
} from "../utils/constants.js";
import type { EntityId, WorkflowActionDef, ActionInputField } from "../profile/types.js";

/**
 * Per-field-type runtime guard: maps each declared input `type` to the predicate
 * its caller value must satisfy. `entityRef` checks only the STRING shape here —
 * its `entityType` scope is validated separately in {@link coerceEntityRef} after
 * this gate. Centralizing the type→predicate mapping keeps {@link coerceField} a
 * single table lookup rather than a branch per type.
 */
const TYPE_GUARDS: Record<ActionInputField["type"], (value: unknown) => boolean> = {
  string: (value) => typeof value === "string",
  entityRef: (value) => typeof value === "string",
  boolean: (value) => typeof value === "boolean",
  number: (value) => typeof value === "number" && Number.isFinite(value),
  "string[]": (value) => Array.isArray(value) && value.every((item) => typeof item === "string"),
};

/**
 * Validate an `entityRef` string: parse it through {@link parseEntityId} (which
 * fails closed on a malformed `<type>/<slug>` id) and require its `entityType` to
 * be one of the field's declared `entityTypes`. The profile validator guarantees a
 * non-empty `entityTypes` on every `entityRef` field, so an out-of-scope (or
 * malformed) ref is the only failure mode here.
 *
 * @param actionId - The action id, for the raised error.
 * @param name - The input field name, for the raised error.
 * @param field - The declared `entityRef` field carrying `entityTypes`.
 * @param value - The candidate ref string.
 * @returns The ref string, unchanged, when in scope.
 */
function coerceEntityRef(actionId: string, name: string, field: ActionInputField, value: string): string {
  const declared = field.entityTypes ?? [];
  let entityType: string;
  try {
    ({ entityType } = parseEntityId(value as EntityId));
  } catch {
    throw new ActionInputError(actionId, `input '${name}' is not a well-formed entity id`);
  }
  if (!declared.includes(entityType)) {
    throw new ActionInputError(actionId, `input '${name}' entityType '${entityType}' is outside declared entityTypes`);
  }
  return value;
}

/**
 * Bound a single string value's length, failing closed when it exceeds
 * {@link MAX_WORKFLOW_INPUT_STRING_CHARS}. Shared by the `string`/`entityRef`
 * fields and by each `string[]` element so one runaway string is rejected with a
 * precise error rather than materialized unbounded for a non-`start` op.
 */
function assertStringLength(actionId: string, name: string, value: string): void {
  if (value.length > MAX_WORKFLOW_INPUT_STRING_CHARS) {
    throw new ActionInputError(actionId, `input '${name}' exceeds ${MAX_WORKFLOW_INPUT_STRING_CHARS} characters`);
  }
}

/**
 * Enforce per-FIELD SIZE caps on a value whose runtime TYPE already matched: a
 * `string`/`entityRef` ≤ {@link MAX_WORKFLOW_INPUT_STRING_CHARS}, a `string[]` ≤
 * {@link MAX_WORKFLOW_INPUT_ARRAY_ITEMS} with EACH element under the string cap.
 * Bounds non-`start` ops too (which lack the start path's whole-payload byte cap).
 */
function assertFieldSize(actionId: string, name: string, field: ActionInputField, value: unknown): void {
  if (field.type === "string[]") {
    const items = value as string[];
    if (items.length > MAX_WORKFLOW_INPUT_ARRAY_ITEMS) {
      throw new ActionInputError(actionId, `input '${name}' exceeds ${MAX_WORKFLOW_INPUT_ARRAY_ITEMS} items`);
    }
    for (const item of items) assertStringLength(actionId, name, item);
  } else if (field.type === "string" || field.type === "entityRef") {
    assertStringLength(actionId, name, value as string);
  }
}

/**
 * Coerce one PRESENT input value against its declared field type, failing closed
 * with {@link ActionInputError} on any mismatch. The type is checked FIRST, then
 * per-field SIZE caps ({@link assertFieldSize}); an `entityRef` is ADDITIONALLY
 * scope-checked via {@link coerceEntityRef}.
 *
 * @param actionId - The action id, for the raised error.
 * @param name - The input field name.
 * @param field - The declared field def.
 * @param value - The present caller value.
 * @returns The validated (and, for refs, scope-checked) value.
 */
function coerceField(actionId: string, name: string, field: ActionInputField, value: unknown): unknown {
  if (!TYPE_GUARDS[field.type](value)) {
    throw new ActionInputError(actionId, `input '${name}' is not a ${field.type}`);
  }
  assertFieldSize(actionId, name, field, value);
  return field.type === "entityRef" ? coerceEntityRef(actionId, name, field, value as string) : value;
}

/**
 * Resolve ONE declared field's normalized value: apply its `default` when the
 * value is absent, raise when a `required` field is absent with no default, and
 * coerce a present value against its declared type. Returns a marker the caller
 * uses to decide whether to include the key (an absent optional field with no
 * default is omitted entirely, never blanked).
 */
function resolveField(actionId: string, name: string, field: ActionInputField, present: boolean, value: unknown): { include: boolean; value?: unknown } {
  if (!present) {
    if (field.default !== undefined) return { include: true, value: field.default };
    if (field.required) throw new ActionInputError(actionId, `required input '${name}' is missing`);
    return { include: false };
  }
  return { include: true, value: coerceField(actionId, name, field, value) };
}

/**
 * Validate caller `inputs` against `def.inputSchema`, returning the normalized
 * inputs (declared keys only, defaults applied). Fails closed with
 * {@link ActionInputError} on an UNDECLARED input key (an action with no
 * `inputSchema` accepts none), a missing `required` field with no `default`, a
 * runtime type mismatch, or a malformed/out-of-scope `entityRef`. Pure: no I/O.
 *
 * @param def - The declared workflow action carrying the optional `inputSchema`.
 * @param inputs - The untrusted caller-supplied inputs.
 * @returns The normalized inputs (only declared keys; defaults applied).
 * @throws {ActionInputError} On any undeclared key or per-field violation.
 */
export function validateActionInputs(def: WorkflowActionDef, inputs: Record<string, unknown>): Record<string, unknown> {
  const schema = def.inputSchema ?? {};
  for (const key of Object.keys(inputs)) {
    if (!Object.hasOwn(schema, key)) throw new ActionInputError(def.label, `unknown input '${key}'`);
  }
  const normalized: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema)) {
    const present = Object.hasOwn(inputs, name);
    const resolved = resolveField(def.label, name, field, present, inputs[name]);
    if (resolved.include) normalized[name] = resolved.value;
  }
  assertNormalizedWithinByteCap(def.label, normalized);
  return normalized;
}

/**
 * Whole-object SIZE backstop for ALL action ops: the normalized inputs serialize
 * within {@link MAX_WORKFLOW_INPUTS_BYTES}. The per-field caps bound each value,
 * but many within-cap fields could still aggregate large, so this is the same
 * ceiling `startWorkflow` enforces — now applied uniformly so non-`start` ops are
 * bounded too, not just the start path.
 */
function assertNormalizedWithinByteCap(actionId: string, normalized: Record<string, unknown>): void {
  const bytes = Buffer.byteLength(JSON.stringify(normalized), "utf8");
  if (bytes > MAX_WORKFLOW_INPUTS_BYTES) {
    throw new ActionInputError(actionId, `inputs of ${bytes} bytes exceed the cap of ${MAX_WORKFLOW_INPUTS_BYTES}`);
  }
}
