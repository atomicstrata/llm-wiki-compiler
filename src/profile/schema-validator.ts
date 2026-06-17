/**
 * Ajv-backed structural validator for v0 profile packs.
 *
 * The published JSON Schema at `./schema/profile.v1.schema.json` (draft
 * 2020-12) is the SINGLE SOURCE OF TRUTH for structural, type, enum, and
 * `additionalProperties` validation. This module compiles that schema ONCE at
 * module load with Ajv2020 and exposes `assertStructurallyValid`, which the
 * profile validator runs FIRST — before any semantic check the schema cannot
 * express (directory confinement, lifecycle FSM, reserved ids).
 *
 * The schema is imported as a JSON module so the bundler (tsup) inlines it
 * into `dist/`; there is no separate runtime file to copy or resolve.
 */

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import { ProfileValidationError } from "./errors.js";
import schema from "./schema/profile.v1.schema.json" with { type: "json" };

/**
 * The compiled schema validator. Compiled once at module load. `strict: true`
 * surfaces any schema authoring mistake (so the schema and runtime can't drift
 * silently); `allErrors` collects every violation for a complete message.
 */
const validateStructure: ValidateFunction = new Ajv2020({
  allErrors: true,
  strict: true,
}).compile(schema);

/**
 * Render one ajv error into a human-readable message. `additionalProperties`
 * errors are reworded to name the offending key as "unknown", matching the
 * fail-closed allowlist vocabulary the rest of the validator uses.
 */
function describeAjvError(error: NonNullable<ValidateFunction["errors"]>[number]): string {
  const at = error.instancePath || "(root)";
  if (error.keyword === "additionalProperties") {
    const key = (error.params as { additionalProperty?: string }).additionalProperty;
    return `${at}: unknown key '${key}'`;
  }
  return `${at} ${error.message}`;
}

/**
 * Validate `raw` against the published JSON Schema, throwing
 * `ProfileValidationError` (with the ajv error path and message) on the first
 * structural violation. This is phase one of the two-phase validator.
 *
 * @param raw - The untrusted, parsed profile object.
 * @throws {ProfileValidationError} When the structure violates the schema.
 */
export function assertStructurallyValid(raw: unknown): void {
  if (validateStructure(raw)) return;
  const errors = validateStructure.errors ?? [];
  const detail = errors.map(describeAjvError).join("; ");
  throw new ProfileValidationError(`profile failed schema validation: ${detail}`);
}
