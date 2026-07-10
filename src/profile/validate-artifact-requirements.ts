/**
 * @file src/profile/validate-artifact-requirements.ts
 * @description Fail-closed LOAD validation of the optional
 * `transitionArtifactRequirements` lifecycle block, split out of `./validate.ts` to
 * stay within the size budget. Mirrors `./validate-relation-requirements.ts`.
 *
 * M1 (declared-but-unenforced window): a required-artifact precondition must be
 * ENFORCEABLE by the write-time checker (`../artifacts/enforce-precondition.ts`),
 * which resolves the ref by reading `meta[field]` and parsing it as an artifactRef.
 * A precondition on a NON-artifactRef field, or naming an undeclared / out-of-field-
 * scope artifact type, or keyed on an unknown state, could never be enforced — so it
 * is a silent security downgrade and is REJECTED at load. The enforceable precondition
 * FAMILY (`artifact-existence`) and its enforcer land TOGETHER in this slice; the
 * loader never accepts a family whose enforcer is absent.
 *
 * M3 (intra-run ordering) lives in {@link collectArtifactOrderingWarnings} — an
 * ADVISORY hint that a required artifact should be produced by a STRICTLY-UPSTREAM
 * workflow stage. It is NOT a load-time gate: a required artifact legitimately
 * produced OUT OF BAND (an `artifact write` action, a human, or a different
 * workflow run) has no upstream stage to find, and would be false-rejected by a
 * hard check. The write-time enforcer (`../artifacts/enforce-precondition.ts`) is
 * the real gate; this is a "you gated an entity on a type no upstream stage
 * produces" hint, surfaced as a load warning rather than a load failure.
 *
 * v0 scope: only a SINGLE `artifactRef` field is an enforceable precondition target.
 * An `artifactRef[]` field is REJECTED at load (a distinct M1 message, not the generic
 * "not a declared artifactRef field" one) — the write-time enforcer
 * (`../artifacts/enforce-precondition.ts`) resolves the field via `parseArtifactRef`,
 * which returns null for an array value, so a precondition on an `artifactRef[]` field
 * would be PERMANENTLY unsatisfiable despite being declared. Array "all-vs-any healthy"
 * semantics also have no `minCount` to hang off (OQ11 is a non-goal), so they're out of
 * scope for this release rather than silently miscompiled.
 */
import type { ArtifactPreconditionReq, ArtifactTypeDef, EntityTypeDef, FieldDef, WorkflowDef } from "./types.js";
import { assert, lifecycleStates } from "./validate-helpers.js";

/** Is `field` the single-ref `artifactRef` type the write-time enforcer can resolve? */
function isArtifactRefField(field: FieldDef | undefined): boolean {
  return field?.type === "artifactRef";
}

/**
 * Validate one {@link ArtifactPreconditionReq}: `field` must be a DECLARED single
 * `artifactRef` field of the entity (else the enforcer has no ref to resolve — M1);
 * `artifactType` must be a DECLARED artifact type; and when the field declares a
 * narrower `artifactTypes` scope, `artifactType` must sit inside it. An `artifactRef[]`
 * field gets its OWN message (v0 supports single-ref only — see file header), distinct
 * from a field that isn't an artifact ref at all.
 */
function assertArtifactReq(
  where: string,
  req: ArtifactPreconditionReq,
  def: EntityTypeDef,
  declaredArtifactTypes: Set<string>,
): void {
  const field = def.fields?.[req.field];
  assert(
    field?.type !== "artifactRef[]",
    `${where} field '${req.field}' is an artifactRef[] field; artifact preconditions support only single artifactRef fields in this release`,
  );
  assert(isArtifactRefField(field), `${where} field '${req.field}' is not a declared artifactRef field — the precondition cannot be enforced`);
  assert(declaredArtifactTypes.has(req.artifactType), `${where} artifactType '${req.artifactType}' is not a declared artifact type`);
  const scope = field!.artifactTypes;
  assert(scope === undefined || scope.includes(req.artifactType), `${where} artifactType '${req.artifactType}' is outside the declared scope of field '${req.field}'`);
}

/**
 * Validate every entity type's optional `transitionArtifactRequirements` block
 * (fail-closed, M1). For each `[state, reqs]`: `state` must be a DECLARED lifecycle
 * state, and each requirement must be well-formed + enforceable (see
 * {@link assertArtifactReq}). An entity without a lifecycle, or a lifecycle without
 * this key, is skipped — omitted-for-default.
 *
 * @param entities - The profile's entity type map.
 * @param artifacts - The profile's declared artifact types (the scope for `artifactType`).
 */
export function assertArtifactRequirementsDeclared(
  entities: Record<string, EntityTypeDef>,
  artifacts: Record<string, ArtifactTypeDef> | undefined,
): void {
  const declaredArtifactTypes = new Set(Object.keys(artifacts ?? {}));
  for (const [entityType, def] of Object.entries(entities)) {
    const lc = def.lifecycle;
    if (!lc?.transitionArtifactRequirements) continue;
    const states = lifecycleStates(lc);
    for (const [state, reqs] of Object.entries(lc.transitionArtifactRequirements)) {
      const where = `entity '${entityType}' lifecycle transitionArtifactRequirements['${state}']`;
      assert(states.has(state), `entity '${entityType}' lifecycle transitionArtifactRequirements references unknown state '${state}'`);
      for (const req of reqs) assertArtifactReq(where, req, def, declaredArtifactTypes);
    }
  }
}

/** The set of artifact types any state of an entity's lifecycle requires. */
function requiredArtifactTypes(def: EntityTypeDef): Set<string> {
  const out = new Set<string>();
  for (const reqs of Object.values(def.lifecycle?.transitionArtifactRequirements ?? {})) {
    for (const req of reqs) out.add(req.artifactType);
  }
  return out;
}

/**
 * Collect an advisory warning for every artifact type a stage's written entity
 * REQUIRES but that no STRICTLY-EARLIER stage in the same workflow produces (M3).
 * Walks stages in declared order, accumulating the artifact types produced so far
 * (`stage.artifactWrites`, from P-A); when a stage writes an entity whose lifecycle
 * requires type `T` and `T` isn't in that accumulated set yet — whether because it's
 * produced same-stage/later, or never produced by this workflow at all (out-of-band
 * production) — a warning is collected rather than thrown.
 */
function collectWorkflowOrderingWarnings(wf: string, def: WorkflowDef, entities: Record<string, EntityTypeDef>): string[] {
  const warnings: string[] = [];
  const producedSoFar = new Set<string>();
  for (const stage of def.stages) {
    for (const entityType of stage.writes) {
      const needed = requiredArtifactTypes(entities[entityType] ?? ({} as EntityTypeDef));
      for (const t of needed) {
        if (!producedSoFar.has(t)) {
          warnings.push(`workflow '${wf}' stage '${stage.id}' writes '${entityType}', which requires artifact type '${t}', but no upstream stage produces it before the page`);
        }
      }
    }
    for (const t of stage.artifactWrites ?? []) producedSoFar.add(t);
  }
  return warnings;
}

/**
 * Collect advisory intra-run write-ordering warnings for required artifacts across
 * all workflows (M3). A no-workflow profile, or a workflow whose written entities
 * require no artifact, contributes nothing. See {@link collectWorkflowOrderingWarnings}
 * for the strictly-upstream rule this hints at.
 *
 * @param workflows - The profile's optional workflow map.
 * @param entities - The profile's entity type map (supplies the required-artifact sets).
 * @returns Zero or more advisory messages; never throws.
 */
export function collectArtifactOrderingWarnings(
  workflows: Record<string, WorkflowDef> | undefined,
  entities: Record<string, EntityTypeDef>,
): string[] {
  if (!workflows) return [];
  const warnings: string[] = [];
  for (const [wf, def] of Object.entries(workflows)) warnings.push(...collectWorkflowOrderingWarnings(wf, def, entities));
  return warnings;
}
