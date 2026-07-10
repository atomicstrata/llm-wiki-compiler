/**
 * @file src/profile/artifact-ref-validate.ts
 * @description Profile-aware (Layer B) `artifactRef` validation. The shared
 * field-contract core ({@link validateEntityFields} / {@link validateFieldsAgainstDefs}
 * in `field-contract.ts`) is profile-BLIND — it only checks that a value is a
 * structurally well-formed ref (Layer A, `artifacts/ref.ts`). Whether the ref's
 * `artifactType` is DECLARED by the profile at all, and whether it is within a
 * field's own narrower `artifactTypes` scope, can only be judged against the
 * profile — that check lives here.
 *
 * {@link entityFieldViolations} is the ONE shared wrapper composing both layers,
 * invoked at EVERY write site that validates fields able to carry an artifactRef
 * (page / lifecycle / relation — see the Task 4 call-site matrix), so a page and
 * a relation reject an undeclared-type ref identically rather than drifting.
 */
import type { ProfilePack, FieldDef, EntityTypeDef } from "./types.js";
import { parseArtifactRef } from "../artifacts/ref.js";
import { validateEntityFields } from "./field-contract.js";

/** One artifactRef-carrying value pulled off a field, paired with its declared scope. */
export interface RefOccurrence {
  field: string;
  scope?: string[];
  raw: unknown;
}

/**
 * Collect every ref value present under an `artifactRef`/`artifactRef[]` field.
 * Exported so `./artifact-lint.js` can reuse this SAME extraction — the write-side
 * (declared/in-scope) and read-side (health) checks scan identically for which
 * values are ref-carrying, and can never drift on that.
 */
export function refValuesFor(fieldDefs: Record<string, FieldDef>, values: Record<string, unknown>): RefOccurrence[] {
  const out: RefOccurrence[] = [];
  for (const [name, def] of Object.entries(fieldDefs)) {
    if (def.type === "artifactRef") out.push({ field: name, scope: def.artifactTypes, raw: values[name] });
    else if (def.type === "artifactRef[]" && Array.isArray(values[name]))
      for (const raw of values[name] as unknown[]) out.push({ field: name, scope: def.artifactTypes, raw });
  }
  return out;
}

/**
 * Validate every `artifactRef`/`artifactRef[]` value under `fieldDefs` against
 * `profile.artifacts`: PATH-FREE messages for a ref whose `artifactType` is not
 * declared by the profile at all, or whose type IS declared but falls outside a
 * field's own narrower `artifactTypes` scope (when set). A value that fails the
 * STRUCTURAL (Layer A) parse is skipped — that is `validateEntityFields`'s job,
 * not this one's — so this function never double-reports a malformed ref.
 *
 * @param profile - The governing profile pack (its `artifacts` block is the schema).
 * @param fieldDefs - The declared field definitions to scan for ref-carrying fields.
 * @param values - The record of named values to validate (frontmatter / attributes).
 * @returns Zero or more PATH-FREE ref-violation messages.
 */
export function validateArtifactRefsAgainstProfile(
  profile: ProfilePack,
  fieldDefs: Record<string, FieldDef>,
  values: Record<string, unknown>,
): string[] {
  const declared = new Set(Object.keys(profile.artifacts ?? {}));
  const out: string[] = [];
  for (const { field, scope, raw } of refValuesFor(fieldDefs, values)) {
    const ref = parseArtifactRef(raw);
    if (!ref) continue; // structural failure is Layer A's job
    if (!declared.has(ref.artifactType))
      out.push(`Field ${JSON.stringify(field)} references undeclared artifact type ${JSON.stringify(ref.artifactType)}.`);
    else if (scope && !scope.includes(ref.artifactType))
      out.push(`Field ${JSON.stringify(field)} references out-of-scope artifact type ${JSON.stringify(ref.artifactType)}.`);
  }
  return out;
}

/**
 * The ONE shared entity-field validator combining Layer A ({@link validateEntityFields}
 * — presence/type/enum/range, including the structural artifactRef shape check)
 * with Layer B ({@link validateArtifactRefsAgainstProfile} — declared/in-scope
 * artifact types). Every write site that validates a page or synthesized
 * frontmatter against its entity type's field contract calls THIS instead of the
 * bare Layer-A check, so an undeclared-type ref is rejected identically wherever
 * entity fields are validated (page create/update, lifecycle transition).
 *
 * @param profile - The governing profile pack (its `artifacts` block is the schema).
 * @param frontmatter - The page's (or synthesized next) frontmatter record.
 * @param def - The resolved entity type definition to validate against.
 * @returns Zero or more PATH-FREE field-violation messages (both layers).
 */
export function entityFieldViolations(
  profile: ProfilePack,
  frontmatter: Record<string, unknown>,
  def: EntityTypeDef,
): string[] {
  return [...validateEntityFields(frontmatter, def), ...validateArtifactRefsAgainstProfile(profile, def.fields ?? {}, frontmatter)];
}
