/**
 * Ajv-backed structural validator for v0 profile packs.
 *
 * The published JSON Schema at `./schema/profile.v1.schema.json` (draft
 * 2020-12) is the SINGLE SOURCE OF TRUTH for structural, type, enum, and
 * `additionalProperties` validation. This module compiles that schema ONCE, on
 * the first validation, with Ajv2020 and exposes `assertStructurallyValid`, which the
 * profile validator runs FIRST — before any semantic check the schema cannot
 * express (directory confinement, lifecycle FSM, reserved ids).
 *
 * The schema is imported as a JSON module so the bundler (tsup) inlines it
 * into `dist/`; there is no separate runtime file to copy or resolve.
 */

import type { ValidateFunction } from "ajv/dist/2020.js";
import { requireOnUse } from "../utils/require-on-use.js";
import { ProfileValidationError } from "./errors.js";
import schema from "./schema/profile.v1.schema.json" with { type: "json" };

let compiledValidator: ValidateFunction | undefined;

/**
 * The Ajv options the runtime compiles the schema with. `strict: true` surfaces
 * any schema authoring mistake (so the schema and runtime can't drift silently);
 * `allErrors` collects every violation for a complete message.
 *
 * The other two only make the compile cheaper, never the validation different.
 * `validateSchema: false` skips checking the schema against the draft 2020-12
 * meta-schema, which compiled that whole meta-schema in every process for a
 * schema that is a bundled constant; the meta-schema check is a test instead
 * (`test/profile-schema-meta.test.ts`). `code.optimize: false` skips Ajv's
 * code-simplification passes over the generated checks: the same keywords run
 * and report the same errors, in a few more lines of generated code.
 */
const PROFILE_SCHEMA_AJV_OPTIONS = {
  allErrors: true, strict: true, validateSchema: false, code: { optimize: false },
} as const;

/**
 * The compiled schema validator. Compiled once per process, on the first
 * validation rather than at module load, so a command that validates no
 * profile pack neither loads Ajv nor pays for the compile.
 */
function structureValidator(): ValidateFunction {
  if (compiledValidator) return compiledValidator;
  const { default: Ajv2020 } = requireOnUse<typeof import("ajv/dist/2020.js")>("ajv/dist/2020.js");
  compiledValidator = new Ajv2020(PROFILE_SCHEMA_AJV_OPTIONS).compile(schema);
  return compiledValidator;
}

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
  const validateStructure = structureValidator();
  if (validateStructure(raw)) return;
  const errors = validateStructure.errors ?? [];
  const detail = errors.map(describeAjvError).join("; ");
  throw new ProfileValidationError(`profile failed schema validation: ${detail}`);
}
