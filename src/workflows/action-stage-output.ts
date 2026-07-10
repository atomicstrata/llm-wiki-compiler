/**
 * @file src/workflows/action-stage-output.ts
 * @description Build a typed PAGE or ARTIFACT {@link StageOutput} from a `submit`
 * action's validated inputs.
 *
 * A `submit` workflow action routes to {@link submitStageOutput} — the one op that
 * writes content — with the output drawn from the action's `inputSchema`/inputs.
 *
 * ## PAGE OR ARTIFACT
 * A `submit` ACTION supports PAGE and ARTIFACT outputs: both need only scalar/string
 * inputs (`entityType`|`artifactType` + `slug`/`body`), which the action `inputSchema`
 * (scalar/string-array/entityRef field types; see `../profile/types.ts`) CAN express.
 * The shape is discriminated by the DECLARED schema — a schema carrying `artifactType`
 * marshals an artifact output, else a page output. Relation/lifecycle stage outputs
 * need an OBJECT payload (a relation `input`, a lifecycle `evidence`) that no action
 * input can carry, so the profile validator REJECTS them (`../profile/validate.ts`) —
 * for those, use the `workflow submit` command (which reads the payload from a file).
 *
 * This is the PURE shape-builder between the already-validated, normalized inputs and
 * the discriminated {@link StageOutput}. It fails closed ({@link ActionInputError}) on
 * a missing required field — BEFORE any I/O. The downstream {@link submitStageOutput}
 * still enforces the full scope (R4 owner) + trust-gate (R5) rules — and for an
 * artifact, the harness-stamped origin — so this adds NO new write authority: it only
 * marshals the inputs into the op's contract.
 */

import { ActionInputError } from "./errors.js";
import type { WorkflowActionDef } from "../profile/types.js";
import type { StageOutput } from "./stage-output.js";

/** Require a string-typed normalized input, failing closed when absent/non-string. */
function requireString(def: WorkflowActionDef, normalized: Record<string, unknown>, name: string): string {
  const value = normalized[name];
  if (typeof value !== "string") {
    throw new ActionInputError(def.label, `submit input '${name}' is required and must be a string`);
  }
  return value;
}

/**
 * Build the typed {@link StageOutput} for a `submit` action from its normalized inputs.
 * The shape is discriminated by the DECLARED `inputSchema`: a schema carrying
 * `artifactType` marshals an ARTIFACT output (`artifactType`/`slug`/`body`), else a
 * PAGE output (`entityType`/`slug`/`body`). Fails closed ({@link ActionInputError}) on a
 * missing required field. PURE: no I/O — the downstream {@link submitStageOutput}
 * enforces scope/owner/trust authority. Relation/lifecycle outputs stay unexpressible
 * (the profile validator rejects them), so this never marshals an object payload.
 *
 * @param def - The declared `submit` action (carrying the `inputSchema` discriminator and error label).
 * @param normalized - The validated, normalized action inputs.
 * @returns The typed page or artifact stage output to submit.
 * @throws {ActionInputError} On a missing required field.
 */
export function buildActionStageOutput(def: WorkflowActionDef, normalized: Record<string, unknown>): StageOutput {
  if (def.inputSchema && Object.hasOwn(def.inputSchema, "artifactType")) {
    return {
      kind: "artifact",
      artifactType: requireString(def, normalized, "artifactType"),
      slug: requireString(def, normalized, "slug"),
      body: requireString(def, normalized, "body"),
    };
  }
  return {
    kind: "page",
    entityType: requireString(def, normalized, "entityType"),
    slug: requireString(def, normalized, "slug"),
    body: requireString(def, normalized, "body"),
  };
}
