/**
 * Fail-closed v0 profile validator — schema-first, two-phase.
 *
 * `validateProfile` is the single enforcing gate between an untrusted raw
 * profile object and a typed `ProfilePack`. It is all-or-nothing: ANY violation
 * throws `ProfileValidationError` and nothing is returned.
 *
 * Validation runs in two phases:
 *  1. STRUCTURAL (ajv): the published JSON Schema at
 *     `./schema/profile.v1.schema.json` (draft 2020-12) is the runtime enforcer
 *     for structure, types, enums, and `additionalProperties` — compiled once in
 *     `schema-validator.ts`. The schema is the single source of truth here; the
 *     hand validator used to drift from it, so that responsibility now lives in
 *     the schema.
 *  2. SEMANTIC (post-ajv): the checks JSON Schema cannot express — directory
 *     canonicalization + uniqueness + reserved-root confinement, requiredFields
 *     references, lifecycle FSM well-formedness, slug-safe entity-type keys,
 *     defensive non-finite-number rejection, the unsupported `extends`
 *     inheritance, relation-type well-formedness (slug-safe keys, declared
 *     endpoints, requiredAttributes membership), lifecycle relation-count
 *     precondition well-formedness (declared state/relation-type, coherent
 *     role/endpoint, satisfiable otherTypes, integer minCount — see
 *     `validate-relation-requirements.ts`), workflow well-formedness
 *     (slug-safe + non-reserved workflow keys, slug-safe and unique stage ids,
 *     declared reads/writes endpoints, well-formed gates), workflow-action
 *     well-formedness (slug-safe dotted + non-reserved action ids, declared
 *     workflow references, well-formed gate/trustGate, gate-requirement rules for
 *     every mutating operation incl. cancel — only `status` is exempt —, and
 *     action-input rules: an entityRef input requires a non-empty `entityTypes`
 *     of declared types, `entityTypes` is rejected on non-entityRef fields, and a
 *     field `default` must match its declared type), lifecycle required-artifact
 *     precondition enforceability (declared state, artifactRef-typed field, declared
 *     + in-scope artifact type — M1) and intra-run DAG ordering (a required artifact
 *     must be produced by a strictly-upstream workflow stage — M3; see
 *     `validate-artifact-requirements.ts`), and (in
 *     `validateProfile` only) reserved profile ids.
 *
 * Validation NEVER mutates the caller's input: the raw object is cloned up
 * front and only the clone is canonicalized and returned. `validateProfileShape`
 * runs both phases EXCEPT the reserved-id rejection, so the built-in default
 * profile (`profileId: "default"`) can be proven to satisfy the same structural
 * contract that disk profiles claiming `"default"` are rejected against.
 * Unreachable lifecycle states are collected as warnings, not errors.
 */

import type { ProfilePack, EntityTypeDef, FieldDef, FieldType, LifecycleDef, RelationTypeDef, WorkflowDef, WorkflowStageDef } from "./types.js";
import { BODY_TIER_TOKEN } from "./types.js";
import { isSlugSafe } from "./identity.js";
import { RESERVED_CORE_VERBS } from "./reserved-verbs.js";
import { assert, parseGrammarGate, lifecycleStates } from "./validate-helpers.js";
import { validateWorkflowActions } from "./validate-workflow-actions.js";
import { assertRelationRequirementsDeclared } from "./validate-relation-requirements.js";
import { assertArtifactRequirementsDeclared, collectArtifactOrderingWarnings } from "./validate-artifact-requirements.js";
import { validateEntityDirectory, isInsidePosixDir } from "./paths.js";
import { assertStructurallyValid } from "./schema-validator.js";
import { ProfileValidationError } from "./errors.js";
import { SOURCES_DIR, LLMWIKI_DIR, EXPORT_DIR, CONCEPTS_DIR, QUERIES_DIR, WORKFLOW_PROJECTION_DIR } from "../utils/constants.js";
import { isValidArtifactFileName, MAX_ARTIFACT_BYTES } from "../artifacts/name.js";
import { getConnectorDef } from "../connectors/registry.js";

export { ProfileValidationError } from "./errors.js";

/**
 * Profile ids reserved by the system. `default` names the in-memory built-in
 * profile, which never loads from disk through `validateProfile` — so a disk
 * profile claiming it is always rejected. `validateProfileShape` skips this gate
 * so the built-in default can be proven structurally well-formed.
 */
const RESERVED_PROFILE_IDS = new Set(["default"]);

/**
 * Entity directories reserved for the built-in DEFAULT profile. A disk profile
 * may not declare an entity at either, otherwise one physical file would carry
 * two identities — a legacy `pages: concepts/<slug>` AND a
 * `profile.entityPages: <type>/<slug>`. `DEFAULT_PROFILE` legitimately uses
 * these, so this gate lives in `validateProfile` (disk) only, NOT
 * `validateProfileShape`.
 */
const RESERVED_DEFAULT_DIRS = new Set([CONCEPTS_DIR, QUERIES_DIR]);

/** Repo-relative roots an entity directory may not overlap. */
const RESERVED_ROOTS = [
  SOURCES_DIR,
  LLMWIKI_DIR,
  ".git",
  "node_modules",
  "dist",
  EXPORT_DIR,
  "wiki/graph",
  WORKFLOW_PROJECTION_DIR,
];

/** The result of a successful validation: the typed pack plus any warnings. */
export interface ProfileValidationResult {
  profile: ProfilePack;
  warnings: string[];
}

/**
 * Reject the unsupported `extends` inheritance with a clear message. ajv already
 * rejects a non-empty `extends` via `maxItems: 0`, but the semantic message
 * names inheritance explicitly (the schema's wording is generic).
 */
function rejectInheritance(raw: ProfilePack): void {
  const ext = raw.extends;
  assert(
    ext === undefined || ext.length === 0,
    "profile inheritance (extends) is not supported in this release",
  );
}

/** Reject any non-finite numeric value on one FieldDef (default/min/max). */
function assertFieldDefFinite(where: string, field: FieldDef): void {
  for (const key of ["default", "min", "max"] as const) {
    const value = field[key];
    if (typeof value === "number") {
      assert(Number.isFinite(value), `${where} has a non-finite ${key}`);
    }
  }
}

/** Reject any non-finite numeric field-def or retrieval value defensively. */
function assertFiniteNumbers(entityType: string, def: EntityTypeDef): void {
  for (const [name, field] of Object.entries(def.fields ?? {})) {
    assertFieldDefFinite(`entity '${entityType}' field '${name}'`, field);
  }
  const weight = def.retrieval?.defaultWeight;
  if (typeof weight === "number") {
    assert(Number.isFinite(weight), `entity '${entityType}' retrieval.defaultWeight must be finite`);
  }
}

/**
 * Reject `artifactTypes` declared on a field whose type is not `artifactRef` /
 * `artifactRef[]` — the property is meaningless (and silently ignored) on any
 * other field type, so a profile author's typo is caught at LOAD rather than
 * producing a scope that never applies. Placement is checked FIRST: a
 * misplaced `artifactTypes` is flagged before its contents, since a field that
 * shouldn't have the property at all makes checking its contents moot.
 *
 * Once placement is confirmed, an artifactRef field's `artifactTypes` scope
 * must be non-empty (an empty array can never be satisfied by any artifact
 * type — the same silently-dead-scope failure as an undeclared entry) and
 * every named type must be DECLARED by the profile's `artifacts` block —
 * otherwise every ref would fail Layer B ({@link validateArtifactRefsAgainstProfile})
 * at runtime, a silently-dead scope caught here at load instead. Shared by
 * entity fields, relation attributes, and artifact-metadata sub-fields, which
 * all carry the same {@link FieldDef} shape.
 */
function assertArtifactTypesScoped(where: string, name: string, field: FieldDef, declaredArtifactTypes: Set<string>): void {
  assert(
    field.artifactTypes === undefined || field.type === "artifactRef" || field.type === "artifactRef[]",
    `${where} field ${JSON.stringify(name)} declares artifactTypes but is not an artifactRef field`,
  );
  if (field.artifactTypes === undefined) return;
  assert(
    field.artifactTypes.length > 0,
    `${where} field ${JSON.stringify(name)} declares an empty artifactTypes — no artifact type could ever satisfy it`,
  );
  for (const t of field.artifactTypes) {
    assert(
      declaredArtifactTypes.has(t),
      `${where} field ${JSON.stringify(name)} artifactTypes references undeclared artifact type ${JSON.stringify(t)}`,
    );
  }
}

/**
 * Reject `artifactTypes` declared on any of an entity type's fields that is not
 * `artifactRef` / `artifactRef[]`, plus scope-contents violations — see
 * {@link assertArtifactTypesScoped}.
 */
function validateArtifactTypesScope(entityType: string, def: EntityTypeDef, declaredArtifactTypes: Set<string>): void {
  for (const [name, field] of Object.entries(def.fields ?? {})) {
    assertArtifactTypesScoped(`entity '${entityType}'`, name, field, declaredArtifactTypes);
  }
}

/** Every requiredFields entry must reference a declared field. */
function validateRequiredFields(entityType: string, def: EntityTypeDef): void {
  for (const name of def.requiredFields ?? []) {
    assert(def.fields?.[name] !== undefined, `entity '${entityType}' requiredFields entry '${name}' is not a declared field`);
  }
}

/**
 * Every `contentTiers` entry must be a declared field OR the reserved
 * {@link BODY_TIER_TOKEN}, and entries must be unique. An omitted or empty
 * `contentTiers` is valid (means "no projection"). A field literally named
 * `body` COLLIDES with the reserved token — the projection's `body` token always
 * emits the page body, so a declared `body` field could never be projected; that
 * ambiguity is rejected at load rather than silently misdirecting to the body.
 */
function validateContentTiers(entityType: string, def: EntityTypeDef): void {
  const seen = new Set<string>();
  for (const entry of def.contentTiers ?? []) {
    const isDeclaredOrBody = def.fields?.[entry] !== undefined || entry === BODY_TIER_TOKEN;
    assert(isDeclaredOrBody, `entity '${entityType}' contentTiers entry '${entry}' must be a declared field or the reserved 'body' token`);
    assert(!(entry === BODY_TIER_TOKEN && def.fields?.[BODY_TIER_TOKEN] !== undefined),
      `entity '${entityType}' declares a field named '${BODY_TIER_TOKEN}', which collides with the reserved contentTiers 'body' token (always the page body); rename the field`);
    assert(!seen.has(entry), `entity '${entityType}' contentTiers has duplicate entry '${entry}'`);
    seen.add(entry);
  }
}

/**
 * Frontmatter keys a transition's evidence may NEVER set, even if declared: the
 * page `slug` (identity, runtime-dropped at transition time) is reserved here so
 * a profile can never declare an unsatisfiable evidence requirement. The
 * lifecycle `field` is reserved too (the transition WRITES it) and is added
 * dynamically in {@link assertEvidenceFieldsDeclared}.
 */
const RESERVED_EVIDENCE_KEYS = new Set(["slug"]);

/**
 * Field types the runtime evidence gate ({@link isEvidencePresent} in
 * `lifecycle.ts`) can satisfy: a non-empty string / number / slug / enum value
 * (a non-empty enum value is a non-empty string), or a non-empty `string[]`.
 * `boolean`, `object`, and `date` are EXCLUDED — the gate rejects booleans and
 * objects (a bare `true` proves only key presence, not justification), and a
 * `date` parses to a Date object the scalar gate cannot accept. A profile
 * declaring an evidence field of an excluded type would LOAD but its target state
 * could never be entered (a permanently dead state), so it is rejected at load.
 */
const EVIDENCE_COMPATIBLE_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  "string",
  "number",
  "integer",
  "slug",
  "string[]",
  "enum",
]);

/**
 * Reject a profile whose `transitionRequirements` declares any evidence field
 * that can never be satisfied via caller evidence — a RESERVED key (`slug`, or
 * the lifecycle `field` the transition writes), one that is NOT a DECLARED entity
 * field, OR one whose declared `type` the runtime evidence gate can never satisfy
 * (see {@link EVIDENCE_COMPATIBLE_TYPES} — `boolean`/`object`/`date` would make
 * the target state permanently unreachable). Requiring evidence fields to be
 * declared makes them first-class typed fields, so the field contract enforces
 * their type/content. Fails closed at profile LOAD.
 */
function assertEvidenceFieldsDeclared(where: string, lc: LifecycleDef, fields?: Record<string, FieldDef>): void {
  const declared = fields ?? {};
  for (const [state, evidenceFields] of Object.entries(lc.transitionRequirements ?? {})) {
    for (const field of evidenceFields) {
      const reserved = RESERVED_EVIDENCE_KEYS.has(field) || field === lc.field;
      assert(!reserved, `${where}: transitionRequirements['${state}'] uses reserved evidence field '${field}'`);
      assert(field in declared, `${where}: transitionRequirements['${state}'] evidence field '${field}' is not a declared field`);
      const type = declared[field].type;
      assert(
        EVIDENCE_COMPATIBLE_TYPES.has(type),
        `${where}: evidence field '${field}' has type '${type}' which can never satisfy the required-evidence gate`,
      );
    }
  }
}

/**
 * Validate a lifecycle FSM and return any unreachable states as warnings.
 *
 * Well-formedness (all throw on violation): the state set is the union of the
 * terminal states and every transition endpoint; initial ∈ states; terminal ⊆
 * states; terminal states have no outgoing transitions; every transition
 * endpoint ∈ states; every transitionRequirements key ∈ states; every
 * transitionRequirements evidence FIELD is a declared, non-reserved entity field
 * (see {@link assertEvidenceFieldsDeclared}); and if the lifecycle `field` maps
 * to a declared field, that field must be an enum whose values equal the state
 * set. Unreachable states are returned, not thrown.
 */
function validateLifecycle(entityType: string, lc: LifecycleDef, fields?: Record<string, FieldDef>): string[] {
  const where = `entity '${entityType}' lifecycle`;
  const states = lifecycleStates(lc);
  assert(states.has(lc.initial), `${where}: initial state '${lc.initial}' is not in the state set`);
  for (const t of lc.terminal) {
    assert(states.has(t), `${where}: terminal state '${t}' is not in the state set`);
    assert(!(lc.transitions[t]?.length), `${where}: terminal state '${t}' has outgoing transitions`);
  }
  for (const key of Object.keys(lc.transitionRequirements ?? {})) {
    assert(states.has(key), `${where}: transitionRequirements references unknown state '${key}'`);
  }
  assertEvidenceFieldsDeclared(where, lc, fields);
  assertLifecycleEnum(where, lc, states, fields);
  return unreachableStates(lc, states).map((s) => `${where}: state '${s}' is unreachable from initial`);
}

/** If the lifecycle field maps to a declared field, it must be an enum = state set. */
function assertLifecycleEnum(where: string, lc: LifecycleDef, states: Set<string>, fields?: Record<string, FieldDef>): void {
  const field = fields?.[lc.field];
  if (!field) return;
  assert(field.type === "enum", `${where}: field '${lc.field}' must be an enum`);
  const values = new Set(field.enum ?? []);
  const sameSize = values.size === states.size;
  const covers = [...states].every((s) => values.has(s));
  assert(sameSize && covers, `${where}: enum values of '${lc.field}' must equal the lifecycle state set`);
}

/** Collect states with no path from `initial` via the transition graph. */
function unreachableStates(lc: LifecycleDef, states: Set<string>): string[] {
  const reached = new Set<string>([lc.initial]);
  const queue = [lc.initial];
  while (queue.length) {
    const current = queue.shift() as string;
    for (const next of lc.transitions[current] ?? []) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  return [...states].filter((s) => !reached.has(s));
}

/** The result of validating one entity: its canonical dir plus any warnings. */
interface EntityValidation {
  canonicalDirectory: string;
  warnings: string[];
}

/**
 * Validate one entity type's SEMANTICS (structure is already ajv-checked).
 * Canonicalizes and confines its directory (returning the canonical form), and
 * validates finite numbers, requiredFields references, and lifecycle.
 */
function validateEntity(entityType: string, def: EntityTypeDef, declaredArtifactTypes: Set<string>): EntityValidation {
  const canonicalDirectory = validateEntityDirectory(def.directory, RESERVED_ROOTS);
  assertFiniteNumbers(entityType, def);
  validateArtifactTypesScope(entityType, def, declaredArtifactTypes);
  validateRequiredFields(entityType, def);
  validateContentTiers(entityType, def);
  const warnings = def.lifecycle ? validateLifecycle(entityType, def.lifecycle, def.fields) : [];
  return { canonicalDirectory, warnings };
}

/**
 * Validate all entities, enforcing slug-safe type keys and CANONICAL directory
 * uniqueness, writing each canonical directory back ON THE CLONE so downstream
 * scanning uses the same path uniqueness was checked against. Returns warnings.
 */
function validateEntities(entities: Record<string, EntityTypeDef>, declaredArtifactTypes: Set<string>): string[] {
  const warnings: string[] = [];
  const dirs = new Map<string, string>();
  for (const [entityType, def] of Object.entries(entities)) {
    assert(isSlugSafe(entityType), `entity type key '${entityType}' must be slug-safe`);
    const { canonicalDirectory, warnings: entityWarnings } = validateEntity(entityType, def, declaredArtifactTypes);
    warnings.push(...entityWarnings);
    const prior = dirs.get(canonicalDirectory);
    assert(prior === undefined, `entities '${prior}' and '${entityType}' share the same directory '${canonicalDirectory}'`);
    dirs.set(canonicalDirectory, entityType);
    def.directory = canonicalDirectory;
  }
  return warnings;
}

/** Every from/to endpoint must reference a DECLARED entity type. */
function validateRelationEndpoints(rel: string, def: RelationTypeDef, entities: Set<string>): void {
  assert(def.from.length > 0, `relation '${rel}' has an empty 'from' endpoint list`);
  assert(def.to.length > 0, `relation '${rel}' has an empty 'to' endpoint list`);
  for (const endpoint of [...def.from, ...def.to]) {
    assert(entities.has(endpoint), `relation '${rel}' endpoint '${endpoint}' is not a declared entity type`);
  }
}

/** requiredAttributes entries must be declared keys in `attributes`; attrs finite. */
function validateRelationAttributes(rel: string, def: RelationTypeDef, declaredArtifactTypes: Set<string>): void {
  const attributes = def.attributes ?? {};
  for (const [name, field] of Object.entries(attributes)) {
    assertFieldDefFinite(`relation '${rel}' attribute '${name}'`, field);
    assertArtifactTypesScoped(`relation '${rel}'`, name, field, declaredArtifactTypes);
  }
  for (const name of def.requiredAttributes ?? []) {
    assert(name in attributes, `relation '${rel}' requiredAttributes references undeclared attribute '${name}'`);
  }
}

/**
 * Validate the optional `relations` block (fail-closed). Each relation-type key
 * must be slug-safe; `from`/`to` must be non-empty and reference declared entity
 * types; `direction` is schema-enforced to `directed`/`symmetric`; attribute
 * FieldDefs must be finite and every `requiredAttributes` entry must name a
 * declared attribute. Symmetric-pair canonicalization is a STORE-time concern
 * (a later slice), so only the def shape is validated here.
 */
function validateRelations(
  relations: Record<string, RelationTypeDef> | undefined,
  entities: Record<string, EntityTypeDef>,
  declaredArtifactTypes: Set<string>,
): void {
  if (!relations) return;
  const declared = new Set(Object.keys(entities));
  for (const [rel, def] of Object.entries(relations)) {
    assert(isSlugSafe(rel), `relation type key '${rel}' must be slug-safe`);
    validateRelationEndpoints(rel, def, declared);
    validateRelationAttributes(rel, def, declaredArtifactTypes);
  }
}

/** Every stage `reads`/`writes` entry must reference a DECLARED entity type. */
function validateStageEndpoints(wf: string, stage: WorkflowStageDef, entities: Set<string>): void {
  for (const endpoint of [...stage.reads, ...stage.writes]) {
    assert(entities.has(endpoint), `workflow '${wf}' stage '${stage.id}' endpoint '${endpoint}' is not a declared entity type`);
  }
}

/** Every stage `artifactWrites` entry must reference a DECLARED artifact type. */
function validateStageArtifactWrites(wf: string, stage: WorkflowStageDef, artifactTypes: Set<string>): void {
  for (const artifactType of stage.artifactWrites ?? []) {
    assert(artifactTypes.has(artifactType), `workflow '${wf}' stage '${stage.id}' artifactWrites '${artifactType}' is not a declared artifact type`);
  }
}

/**
 * A stage id must be slug-safe, unique within its workflow, and its gate
 * well-formed. A `trust:` stage gate ADDITIONALLY requires a producible output —
 * a declared entity write OR an artifact write (P-A): a trust gate is
 * satisfiable ONLY by a stage output, so a `trust:`-gated stage with neither
 * would load but be permanently stuck at runtime — rejected at load (M2).
 * `human:`/`agent:` gates are satisfied by approval regardless of output, so
 * they stay valid with no writes/artifactWrites.
 */
function validateStage(wf: string, stage: WorkflowStageDef, seen: Set<string>, entities: Set<string>, artifactTypes: Set<string>): void {
  assert(isSlugSafe(stage.id), `workflow '${wf}' stage id '${stage.id}' must be slug-safe`);
  assert(!seen.has(stage.id), `workflow '${wf}' has a duplicate stage id '${stage.id}'`);
  seen.add(stage.id);
  validateStageEndpoints(wf, stage, entities);
  validateStageArtifactWrites(wf, stage, artifactTypes);
  if (stage.gate !== undefined) {
    const kind = parseGrammarGate(stage.gate);
    assert(kind !== null, `workflow '${wf}' stage '${stage.id}' has a malformed gate '${stage.gate}'`);
    if (kind === "trust") {
      const producesOutput = stage.writes.length > 0 || (stage.artifactWrites ?? []).length > 0;
      assert(producesOutput, `workflow '${wf}' stage '${stage.id}' has a 'trust:' gate but declares no writes or artifactWrites — a trust gate is satisfiable only by a stage output`);
    }
  }
}

/**
 * Validate the stage-rename `previousIds` declarations across one workflow
 * (fail-closed). Each previousId must be slug-safe; a previousId may NOT equal any
 * CURRENT stage id in the same workflow (a rename replaces a REMOVED id, never
 * aliases a live one); and no two stages may share the same previousId (the old→new
 * mapping must be unambiguous). `currentIds` is the set of declared stage ids.
 */
function assertStagePreviousIds(wf: string, def: WorkflowDef, currentIds: Set<string>): void {
  const claimedBy = new Map<string, string>();
  for (const stage of def.stages) {
    for (const previousId of stage.previousIds ?? []) {
      assert(isSlugSafe(previousId), `workflow '${wf}' stage '${stage.id}' previousId '${previousId}' must be slug-safe`);
      assert(!currentIds.has(previousId), `workflow '${wf}' stage '${stage.id}' previousId '${previousId}' is also a current stage id`);
      const prior = claimedBy.get(previousId);
      assert(prior === undefined, `workflow '${wf}' previousId '${previousId}' is claimed by both stage '${prior}' and stage '${stage.id}'`);
      claimedBy.set(previousId, stage.id);
    }
  }
}

/**
 * The reserved roots a `projectionFile` is checked against. The projection
 * subtree itself ({@link WORKFLOW_PROJECTION_DIR}) is EXCLUDED here: a projection
 * legitimately lives INSIDE it (so it must not be rejected as overlapping a
 * reserved root), while {@link validateProjectionFile} separately REQUIRES the
 * target be confined under that subtree.
 */
const PROJECTION_RESERVED_ROOTS = RESERVED_ROOTS.filter((root) => root !== WORKFLOW_PROJECTION_DIR);

/**
 * Confine an optional workflow `projectionFile` to the RESERVED projection
 * subtree so it can never clobber an authored wiki page. The schema accepts an
 * unconstrained string, so an unvalidated `"../../etc/passwd"`, `/etc/passwd`, or
 * even a clean-but-hostile `wiki/concepts/important.md` would later be written to.
 * Two layered checks (fail-closed at profile LOAD): (1) the same lexical
 * confinement entity directories use ({@link validateEntityDirectory}) rejects
 * absolute paths, `..`/NUL segments, and anything not under `wiki/`; (2) the
 * canonical target MUST sit under {@link WORKFLOW_PROJECTION_DIR} (the only place
 * a projection may write), so a clean `wiki/`-path that targets a real page is
 * rejected — the page-clobber vector is gone at validation.
 */
function validateProjectionFile(wf: string, def: WorkflowDef): void {
  if (def.projectionFile === undefined) return;
  let canonical: string;
  try {
    canonical = validateEntityDirectory(def.projectionFile, PROJECTION_RESERVED_ROOTS);
  } catch (err) {
    assert(false, `workflow '${wf}' projectionFile is not a safe path under 'wiki/': ${(err as Error).message}`);
    return; // unreachable: assert(false) throws; satisfies the definite-assignment check
  }
  assert(
    isInsidePosixDir(canonical, WORKFLOW_PROJECTION_DIR),
    `workflow '${wf}' projectionFile must live under '${WORKFLOW_PROJECTION_DIR}/': ${def.projectionFile}`,
  );
}

/**
 * Validate the optional `workflows` block (fail-closed). Each workflow key must
 * be slug-safe and must NOT collide with a reserved core CLI verb (see
 * {@link RESERVED_CORE_VERBS}). Within a workflow, every stage id must be
 * slug-safe and unique, every `reads`/`writes` entry must reference a declared
 * entity type, any `gate` must match `<kind>:<id>` for kind ∈ {trust,human,agent},
 * any stage `previousIds` rename source must be slug-safe, must not alias a current
 * stage id, and must be claimed by at most one stage, and any `projectionFile` must
 * be a confined path under `wiki/`. Every stage `artifactWrites` entry must
 * reference a declared artifact type (`declaredArtifactTypes`, shared with
 * {@link validateEntities}/{@link validateRelations}). This is SCHEMA +
 * VALIDATION only: workflows are never executable and carry no run state in
 * this slice.
 */
function validateWorkflows(
  workflows: Record<string, WorkflowDef> | undefined,
  entities: Record<string, EntityTypeDef>,
  declaredArtifactTypes: Set<string>,
): void {
  if (!workflows) return;
  const declared = new Set(Object.keys(entities));
  for (const [wf, def] of Object.entries(workflows)) {
    assert(isSlugSafe(wf), `workflow key '${wf}' must be slug-safe`);
    assert(!RESERVED_CORE_VERBS.has(wf), `workflow id '${wf}' is reserved — it collides with a core CLI verb`);
    const seen = new Set<string>();
    for (const stage of def.stages) validateStage(wf, stage, seen, declared, declaredArtifactTypes);
    assertStagePreviousIds(wf, def, seen);
    validateProjectionFile(wf, def);
  }
}

/**
 * Semantic checks the JSON schema cannot express for artifact type declarations.
 * `declaredArtifactTypes` is threaded in (rather than recomputed from `profile`)
 * so this shares the exact same declared set as {@link validateEntities} /
 * {@link validateRelations} — a metadata sub-field's `artifactTypes` scope is
 * judged against the same profile-wide truth.
 */
function validateArtifacts(profile: ProfilePack, declaredArtifactTypes: Set<string>): void {
  const artifacts = profile.artifacts;
  if (!artifacts) return;
  for (const [id, def] of Object.entries(artifacts)) {
    assert(isSlugSafe(id), `artifact type id ${JSON.stringify(id)} is not slug-safe`);
    assert(isValidArtifactFileName(def.fileName, def.contentKind),
      `artifact ${JSON.stringify(id)} fileName ${JSON.stringify(def.fileName)} is not a valid ${def.contentKind} filename`);
    assert(def.maxBytes >= 1 && def.maxBytes <= MAX_ARTIFACT_BYTES,
      `artifact ${JSON.stringify(id)} maxBytes must be in 1..${MAX_ARTIFACT_BYTES}`);
    assert(def.contentKind === "json" || def.metadata === undefined,
      `artifact ${JSON.stringify(id)} metadata is permitted only when contentKind is "json"`);
    // The SHARED FieldType union includes artifactRef, which would make `metadata`
    // a third consumer of it — but Layer B and ref-health never run on artifact
    // bodies, so a nested artifact→artifact ref would be silently half-supported.
    // Refuse at load. A metadata sub-field is also a THIRD `artifactTypes` carrier
    // (alongside entity fields and relation attributes) reachable by no other
    // check, so it gets the same placement scrutiny here (the declared/empty
    // branches are structurally unreachable for metadata — the guard above
    // already rejects artifactRef-typed metadata fields before this call runs,
    // and v0 has no nested artifactRef — but wired for forward-compat).
    for (const [field, fd] of Object.entries(def.metadata ?? {})) {
      assert(fd.type !== "artifactRef" && fd.type !== "artifactRef[]",
        `artifact ${JSON.stringify(id)} metadata field ${JSON.stringify(field)} is artifactRef-typed — nested artifact refs are not supported in v0`);
      assertArtifactTypesScoped(`artifact ${JSON.stringify(id)} metadata`, field, fd, declaredArtifactTypes);
    }
  }
}

/** Validate pure-data connector bindings against the static connector registry and entity fields. */
function validateConnectors(profile: ProfilePack): void {
  for (const [connectorId, binding] of Object.entries(profile.connectors ?? {})) {
    assert(isSlugSafe(connectorId), `connector id '${connectorId}' must be slug-safe`);
    const def = getConnectorDef(connectorId);
    assert(def !== undefined, `connector '${connectorId}' is not registered`);
    const entity = profile.entities[binding.entityType];
    assert(entity !== undefined, `connector '${connectorId}' entityType '${binding.entityType}' is not declared`);
    const draftFields = new Set(def.draftFields);
    for (const [draftField, entityField] of Object.entries(binding.fields)) {
      assert(draftFields.has(draftField), `connector '${connectorId}' draft field '${draftField}' is not emitted by connector '${connectorId}'`);
      assert(entity.fields?.[entityField] !== undefined, `connector '${connectorId}' entity field '${entityField}' is not declared on '${binding.entityType}'`);
    }
    if (binding.contentField !== undefined) {
      assert(draftFields.has(binding.contentField), `connector '${connectorId}' contentField '${binding.contentField}' is not emitted by connector '${connectorId}'`);
    }
  }
}

/**
 * Validate a raw profile's SHAPE: the ajv structural gate plus every semantic
 * check, EXCEPT the reserved profileId rejection. The built-in default profile
 * passes this; disk profiles claiming `"default"` are still rejected by
 * `validateProfile`. Non-mutating: clones the input and returns the canonical
 * clone.
 */
export function validateProfileShape(raw: unknown): ProfileValidationResult {
  assertStructurallyValid(raw);
  const profile = structuredClone(raw) as ProfilePack;
  rejectInheritance(profile);
  const declaredArtifactTypes = new Set(Object.keys(profile.artifacts ?? {}));
  const warnings = validateEntities(profile.entities, declaredArtifactTypes);
  validateRelations(profile.relations, profile.entities, declaredArtifactTypes);
  assertRelationRequirementsDeclared(profile.entities, profile.relations);
  validateWorkflows(profile.workflows, profile.entities, declaredArtifactTypes);
  validateWorkflowActions(profile.workflowActions, profile.workflows, profile.entities);
  validateArtifacts(profile, declaredArtifactTypes);
  validateConnectors(profile);
  assertArtifactRequirementsDeclared(profile.entities, profile.artifacts);
  warnings.push(...collectArtifactOrderingWarnings(profile.workflows, profile.entities));
  return { profile, warnings };
}

/**
 * Validate a raw, untrusted profile object into a typed `ProfilePack`.
 *
 * Two-phase and fail-closed: the ajv schema gate runs first, then the semantic
 * checks. Adds the disk-only reserved-id rejection on top of
 * `validateProfileShape`. Never mutates the caller's input; returns the
 * canonical clone with any (non-fatal) warnings.
 */
export function validateProfile(raw: unknown): ProfileValidationResult {
  const result = validateProfileShape(raw);
  assert(!RESERVED_PROFILE_IDS.has(result.profile.profileId), `profileId '${result.profile.profileId}' is reserved`);
  rejectReservedDefaultDirs(result.profile);
  rejectReservedEntityTypeNames(result.profile);
  return result;
}

/**
 * Reject any entity whose canonical directory is one of the default profile's
 * reserved dirs (`wiki/concepts` / `wiki/queries`). Operates on the canonical
 * directory written back by {@link validateProfileShape}, so `.`-padded aliases
 * are caught too.
 */
function rejectReservedDefaultDirs(profile: ProfilePack): void {
  for (const [entityType, def] of Object.entries(profile.entities)) {
    assert(
      !RESERVED_DEFAULT_DIRS.has(def.directory),
      `entity '${entityType}' directory '${def.directory}' is reserved for the default profile`,
    );
  }
}

/**
 * The basename set of directories reserved for the default profile, used to
 * guard entity TYPE NAMES. An entity type named `concepts` or `queries` would
 * mint `EntityId "concepts/<slug>"` which collides with the legacy
 * `PageId "concepts/<slug>"` — corrupting the viewer graph and ranking map.
 * Derived from `RESERVED_DEFAULT_DIRS` so no strings are hard-coded here.
 */
const RESERVED_ENTITY_TYPE_NAMES = new Set(
  [...RESERVED_DEFAULT_DIRS].map((dir) => dir.split("/").at(-1) as string),
);

/**
 * Reject any entity TYPE NAME equal to a reserved default-profile page
 * directory basename. Disk-only guard (lives in `validateProfile`): the built-in
 * `DEFAULT_PROFILE` legitimately uses these names, so `validateProfileShape`
 * must not enforce this.
 */
function rejectReservedEntityTypeNames(profile: ProfilePack): void {
  for (const entityType of Object.keys(profile.entities)) {
    assert(
      !RESERVED_ENTITY_TYPE_NAMES.has(entityType),
      `entity type name '${entityType}' is reserved — it collides with the default profile's page directory name`,
    );
  }
}
