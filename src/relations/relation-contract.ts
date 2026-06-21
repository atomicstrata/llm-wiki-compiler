/**
 * @file src/relations/relation-contract.ts
 * @description The single, PURE relation-contract validators shared by the WRITE
 * path (planner + store) and the READ surfaces (lint / status / export).
 *
 * Two concerns, both built on the ONE field-contract core
 * ({@link validateFieldsAgainstDefs}) so a relation attribute is checked against
 * exactly the same type/enum/min/max rules as an entity field (DRY):
 *
 *   - {@link validateRelationAttributes}: a relation's `attributes` against its
 *     relation-type def's declared `attributes` (typed) + `requiredAttributes`
 *     (presence). Used at write time so an attribute violating its declared type
 *     never lands on disk.
 *   - {@link validateRelationAgainstProfile}: a STORED relation re-checked against
 *     the CURRENT profile — its type still declared, endpoints still within the
 *     declared `from`/`to` entity sets, and attributes still satisfying the
 *     contract. Used by the read surfaces to reclassify (never delete) records
 *     that the profile has since outgrown.
 *
 * Both are pure (no I/O), never throw, and carry no path context — callers wrap
 * each message into their own error/finding/problem shape.
 */

import { validateFieldsAgainstDefs } from "../profile/field-contract.js";
import { parseEntityId, EntityIdError } from "../profile/identity.js";
import type { EntityId, ProfilePack, RelationTypeDef } from "../profile/types.js";
import type { RelationRef } from "./types.js";

/**
 * Validate a relation's `attributes` against its relation-type def: every declared
 * attribute value must satisfy its `FieldDef` (type/enum/min/max), and every name
 * in `requiredAttributes` must be present. An attribute NOT declared by the def is
 * allowed (extra attributes, mirroring entity extra-frontmatter). Returns the
 * PATH-FREE violation messages (empty when the attributes are valid).
 *
 * @param def - The resolved relation-type definition (its `attributes` is the schema).
 * @param attributes - The relation instance's attributes.
 * @returns Zero or more PATH-FREE attribute-violation messages.
 */
export function validateRelationAttributes(
  def: RelationTypeDef,
  attributes: Record<string, unknown>,
): string[] {
  return validateFieldsAgainstDefs(
    attributes,
    def.attributes ?? {},
    def.requiredAttributes ?? [],
    (name) => `missing required attribute '${name}'`,
  );
}

/** True when an EntityId's entity type is in the allowed set for its endpoint side. */
function endpointTypeAllowed(id: EntityId, allowed: string[]): boolean {
  try {
    return allowed.includes(parseEntityId(id).entityType);
  } catch (err) {
    if (err instanceof EntityIdError) return false;
    throw err;
  }
}

/**
 * Re-validate a STORED relation against the CURRENT profile, returning the
 * PATH-FREE reasons it is no longer valid (empty when it still satisfies the
 * profile). A relation is invalid when its `type` is no longer declared, an
 * endpoint's entity type is no longer within the def's declared `from`/`to` set,
 * or its attributes no longer satisfy the declared field contract.
 *
 * This NEVER mutates or deletes — it only classifies, so the read surfaces can
 * retain-and-warn (the spec's profile-adaptation policy).
 *
 * @param ref - The stored relation reference.
 * @param profile - The current governing profile pack.
 * @returns Zero or more PATH-FREE reasons the relation is now invalid.
 */
export function validateRelationAgainstProfile(ref: RelationRef, profile: ProfilePack): string[] {
  const def = profile.relations?.[ref.type];
  if (!def) return [`relation type ${JSON.stringify(ref.type)} is no longer declared by the profile`];
  const reasons: string[] = [];
  if (!endpointTypeAllowed(ref.from, def.from)) {
    reasons.push(`relation ${ref.id} from endpoint ${ref.from} is no longer an allowed entity type`);
  }
  if (!endpointTypeAllowed(ref.to, def.to)) {
    reasons.push(`relation ${ref.id} to endpoint ${ref.to} is no longer an allowed entity type`);
  }
  reasons.push(...validateRelationAttributes(def, ref.attributes));
  return reasons;
}
