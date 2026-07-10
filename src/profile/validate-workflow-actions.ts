/**
 * @file src/profile/validate-workflow-actions.ts
 * @description Fail-closed validation of the optional `workflowActions` profile block.
 *
 * Split out of `./validate.ts` (which validates entities/relations/workflows) so each
 * file stays focused and within the size budget. The single entry point
 * {@link validateWorkflowActions} is called from `validateProfileShape`. Every check
 * fails closed via the shared {@link assert} (throwing {@link ProfileValidationError}),
 * turning a misconfigured action into a clear load-time error rather than a runtime
 * surprise: a malformed id, an undeclared workflow, a malformed gate contract, an
 * out-of-scope entityRef input, a runId-bearing action that forgets to declare `runId`,
 * or a `submit` action shaped for an unsupported relation/lifecycle payload.
 */

import type {
  EntityTypeDef,
  WorkflowDef,
  WorkflowActionDef,
  ActionInputField,
  EntityId,
} from "./types.js";
import { isSlugSafe, parseEntityId, EntityIdError } from "./identity.js";
import { RESERVED_CORE_VERBS } from "./reserved-verbs.js";
import { ProfileValidationError } from "./errors.js";
import { assert, parseGrammarGate } from "./validate-helpers.js";

/**
 * The single read-only action operation. Every OTHER operation mutates, so it must
 * declare a gate or trustGate; only `status` may declare neither. Deriving the rule
 * from this one constant keeps the gate-requirement check exhaustive as the operation
 * schema-enum grows.
 */
const READ_ONLY_OPERATION = "status";

/**
 * Assert that a workflow-action id is a slug-safe DOTTED id (`<domain>.<action>`):
 * at least two non-empty, slug-safe, dot-separated segments. It must NOT collide
 * with a reserved core CLI verb — neither the FULL dotted id nor its FIRST segment
 * alone (a profile must not shadow `compile.x` etc.).
 */
function assertActionIdWellFormed(actionId: string): void {
  const segments = actionId.split(".");
  assert(segments.length >= 2, `workflow action id '${actionId}' must be a dotted '<domain>.<action>' id`);
  for (const segment of segments) {
    assert(isSlugSafe(segment), `workflow action id '${actionId}' segment '${segment}' must be slug-safe`);
  }
  assert(!RESERVED_CORE_VERBS.has(actionId), `workflow action id '${actionId}' is reserved — it collides with a core CLI verb`);
  assert(!RESERVED_CORE_VERBS.has(segments[0]), `workflow action id '${actionId}' first segment '${segments[0]}' is reserved — it collides with a core CLI verb`);
}

/**
 * Assert a workflow action's gate contract. A `gate`, if present, must be a
 * `human:`/`agent:` `<kind>:<id>` (a `trust:` kind is rejected — trust gates live
 * in `trustGate`). A `trustGate`, if present, must be a `trust:<id>`. A `gate`
 * operation MUST declare a `gate`; every MUTATING operation (every operation
 * except read-only `status`) must declare a `gate` OR a `trustGate`.
 */
function assertActionGates(actionId: string, def: WorkflowActionDef): void {
  if (def.gate !== undefined) {
    const kind = parseGrammarGate(def.gate);
    assert(kind === "human" || kind === "agent", `workflow action '${actionId}' has a malformed gate '${def.gate}'`);
  }
  if (def.trustGate !== undefined) {
    assert(parseGrammarGate(def.trustGate) === "trust", `workflow action '${actionId}' has a malformed trustGate '${def.trustGate}'`);
  }
  if (def.operation === "gate") {
    assert(def.gate !== undefined, `workflow action '${actionId}' operation 'gate' must declare a gate`);
  }
  if (def.operation !== READ_ONLY_OPERATION) {
    assert(def.gate !== undefined || def.trustGate !== undefined, `workflow action '${actionId}' operation '${def.operation}' must declare a gate or trustGate`);
  }
}

/** Whether a runtime value matches an input field's declared `type`. */
function defaultMatchesType(type: ActionInputField["type"], value: unknown): boolean {
  switch (type) {
    case "string":
    case "entityRef":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "string[]":
      return Array.isArray(value) && value.every((item) => typeof item === "string");
  }
}

/** A field's `entityTypes` is meaningful ONLY on an entityRef: scope it / reject elsewhere. */
function assertEntityTypesScope(where: string, field: ActionInputField, entities: Set<string>): void {
  if (field.type !== "entityRef") {
    assert(field.entityTypes === undefined, `${where} carries 'entityTypes' but is not an entityRef`);
    return;
  }
  const types = field.entityTypes ?? [];
  assert(types.length > 0, `${where} (entityRef) must declare a non-empty 'entityTypes'`);
  for (const entityType of types) {
    assert(entities.has(entityType), `${where} entityRef '${entityType}' is not a declared entity type`);
  }
}

/**
 * Assert an `entityRef` field's `default` is a QUALIFIED `<type>/<slug>` id whose
 * entityType is one of the field's declared `entityTypes`. A malformed id (no
 * slash / non-slug-safe halves) or an out-of-scope entityType is rejected. Layered
 * ON TOP of the string type-check in {@link defaultMatchesType}.
 */
function assertEntityRefDefaultInScope(where: string, field: ActionInputField): void {
  const declared = field.entityTypes ?? [];
  try {
    const { entityType } = parseEntityId(field.default as EntityId);
    assert(declared.includes(entityType), `${where} default '${String(field.default)}' has entityType '${entityType}' outside declared entityTypes`);
  } catch (error) {
    if (error instanceof EntityIdError) {
      throw new ProfileValidationError(`${where} default '${String(field.default)}' is not a qualified <type>/<slug> entity id`);
    }
    throw error;
  }
}

/**
 * Validate one action's `inputSchema` (fail-closed): an `entityRef` field MUST
 * declare a NON-EMPTY `entityTypes` of DECLARED types; a non-entityRef field must
 * NOT carry `entityTypes`; any `default` must match the field's runtime type; and
 * an `entityRef` default must be a qualified id whose entityType is in scope.
 */
function assertActionInputSchema(actionId: string, def: WorkflowActionDef, entities: Set<string>): void {
  for (const [name, field] of Object.entries(def.inputSchema ?? {})) {
    const where = `workflow action '${actionId}' input '${name}'`;
    assertEntityTypesScope(where, field, entities);
    if (field.default !== undefined) {
      assert(defaultMatchesType(field.type, field.default), `${where} default does not match type '${field.type}'`);
      if (field.type === "entityRef") assertEntityRefDefaultInScope(where, field);
    }
  }
}

/** The `inputSchema` fields a PAGE submit action's marshaller consumes (all required). */
const PAGE_SUBMIT_FIELDS = ["entityType", "slug", "body"] as const;

/** The `inputSchema` fields an ARTIFACT submit action's marshaller consumes (all required). */
const ARTIFACT_SUBMIT_FIELDS = ["artifactType", "slug", "body"] as const;

/**
 * The action operations whose EXECUTION requires a mandatory `runId` input (the run
 * to act on; see `runAction`'s `requireRunId`). `start` mints a fresh run and `status`
 * takes an OPTIONAL `runId` (absent → all runs), so both are exempt.
 */
const RUNID_REQUIRED_OPERATIONS: ReadonlySet<WorkflowActionDef["operation"]> =
  new Set(["resume", "advance", "gate", "cancel", "fail", "submit"]);

/**
 * Assert an action whose `operation` requires a `runId` at execution
 * ({@link RUNID_REQUIRED_OPERATIONS}) DECLARES `runId` as a REQUIRED `string` input in
 * its `inputSchema`. Without it the action validates at load yet can NEVER be invoked:
 * `validateActionInputs` rejects the caller-supplied `runId` as an undeclared key
 * (`unknown input 'runId'`), so the profile would expose a dead action. Requiring it
 * `required: true` AND `default === undefined` turns that into a clear load-time error
 * and KEEPS the run per-invocation: the input resolver applies a `default` BEFORE the
 * missing-required check, so a defaulted `runId` would let a mutating action target one
 * hardcoded run with no explicit caller input — defeating the per-invocation contract.
 * Applies to EVERY runId-bearing op (not just `submit`), so no sibling op silently ships
 * an unusable (or implicitly-targeted) action.
 */
function assertRunIdBearingActionDeclaresRunId(actionId: string, def: WorkflowActionDef): void {
  if (!RUNID_REQUIRED_OPERATIONS.has(def.operation)) return;
  const runId = (def.inputSchema ?? {}).runId;
  assert(
    runId !== undefined,
    `workflow action '${actionId}' operation '${def.operation}' requires a 'runId' input declared in its inputSchema (else it can never be invoked)`,
  );
  assert(
    runId.type === "string" && runId.required === true && runId.default === undefined,
    `workflow action '${actionId}' input 'runId' must be a required 'string' with no default (type: "string", required: true) — the target run is per-invocation`,
  );
}

/**
 * Assert a `submit` action's `inputSchema` is PAGE-shaped OR ARTIFACT-shaped. Page and
 * artifact outputs need only scalar/string inputs (expressible), so both are admitted;
 * relation/lifecycle outputs need an OBJECT payload an action input cannot carry and
 * stay rejected (use the `workflow submit` command). A page shape declares
 * {@link PAGE_SUBMIT_FIELDS}; an artifact shape declares {@link ARTIFACT_SUBMIT_FIELDS}
 * and `artifactType` (the discriminator page shapes never carry).
 */
function assertSubmitActionPageOrArtifact(actionId: string, def: WorkflowActionDef): void {
  if (def.operation !== "submit") return;
  const schema = def.inputSchema ?? {};
  for (const field of ["input", "toState", "evidence", "kind"] as const) {
    assert(!Object.hasOwn(schema, field), `workflow action '${actionId}' is a 'submit' action declaring a '${field}' input — submit actions support page or artifact outputs only; use the 'workflow submit' command for relation/lifecycle outputs`);
  }
  const isArtifact = Object.hasOwn(schema, "artifactType");
  assert(
    !Object.hasOwn(schema, isArtifact ? "entityType" : "artifactType"),
    `workflow action '${actionId}' submit action inputSchema declares both entityType and artifactType; a submit output is page OR artifact, not both`,
  );
  const required = isArtifact ? ARTIFACT_SUBMIT_FIELDS : PAGE_SUBMIT_FIELDS;
  for (const field of required) {
    assert(Object.hasOwn(schema, field), `workflow action '${actionId}' is a 'submit' action missing the required ${isArtifact ? "artifact" : "page"} input '${field}'`);
  }
}

/**
 * Validate the optional `workflowActions` block (fail-closed). Each action id must
 * be a slug-safe DOTTED id that does not collide with a reserved core CLI verb
 * (full id or first segment); `workflow` must reference a DECLARED workflow (so an
 * absent or incomplete `workflows` block fails); `operation` is schema-enforced to
 * the allowed set; `gate`/`trustGate` must be well-formed and a `gate`/write/advance
 * action must declare the required gate; every entityRef input must name a declared
 * entity type; a runId-bearing op must declare its `runId` input; and a `submit`
 * action must be page- or artifact-shaped.
 */
export function validateWorkflowActions(
  workflowActions: Record<string, WorkflowActionDef> | undefined,
  workflows: Record<string, WorkflowDef> | undefined,
  entities: Record<string, EntityTypeDef>,
): void {
  if (!workflowActions) return;
  const declaredWorkflows = new Set(Object.keys(workflows ?? {}));
  const declaredEntities = new Set(Object.keys(entities));
  for (const [actionId, def] of Object.entries(workflowActions)) {
    assertActionIdWellFormed(actionId);
    assert(declaredWorkflows.has(def.workflow), `workflow action '${actionId}' references '${def.workflow}', which is not a declared workflow`);
    assertActionGates(actionId, def);
    assertActionInputSchema(actionId, def, declaredEntities);
    assertRunIdBearingActionDeclaresRunId(actionId, def);
    assertSubmitActionPageOrArtifact(actionId, def);
  }
}
