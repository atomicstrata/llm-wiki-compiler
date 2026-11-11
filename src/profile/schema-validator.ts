/**
 * Structural validator for v0 profile packs.
 *
 * The published JSON Schema at `./schema/profile.v1.schema.json` (draft
 * 2020-12) is the SINGLE SOURCE OF TRUTH for structural, type, enum, and
 * `additionalProperties` validation. Ajv compiles it ahead of time into
 * `./schema/profile-validator.generated.ts` (`bun scripts/generate-profile-validator.ts`;
 * a test fails when the two drift), so no process loads Ajv or compiles the
 * schema. The profile validator runs `assertStructurallyValid` FIRST — before
 * any semantic check the schema cannot express (directory confinement,
 * lifecycle FSM, reserved ids).
 */

import type { ValidateFunction } from "ajv/dist/2020.js";
import { ProfileValidationError } from "./errors.js";
import { validate as validateGenerated } from "./schema/profile-validator.generated.js";

const validateStructure = validateGenerated as ValidateFunction;

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
