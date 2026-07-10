/**
 * @file src/profile/validate-relation-requirements.ts
 * @description Fail-closed LOAD validation of the optional
 * `transitionRelationRequirements` lifecycle block.
 *
 * Split out of `./validate.ts` (entities/relations/workflows) so each file stays
 * focused and within the size budget. The single entry point
 * {@link assertRelationRequirementsDeclared} is called from `validateProfileShape`
 * (after the relation block is validated, so relation defs are known-sound). This
 * is LOAD VALIDATION ONLY: it proves a declared relation-count precondition is
 * well-formed and structurally SATISFIABLE — nothing here counts relation
 * instances or gates a write (the runtime write-time gate lives in
 * `../relations/enforce-precondition.ts`; the read-side standing re-check in
 * `./relation-standing.ts`).
 *
 * Every check fails closed via the shared {@link assert} (throwing
 * {@link ProfileValidationError}), turning a misconfigured precondition into a
 * clear load-time error rather than a permanently-unreachable lifecycle state: an
 * unknown state, an undeclared relation type, a role on a symmetric relation, this
 * entity not being a legal role-side endpoint (count always 0), an `otherTypes`
 * that is empty or not a legal opposite-side endpoint, a non-integer/`< 1`
 * `minCount`, or an `otherStates` that is empty, duplicated, names an undeclared
 * lifecycle state, or targets other types NONE of which declares a lifecycle
 * (the filter would be unsatisfiable — the count always 0).
 *
 * DECISION — symmetric relations are role-free, so a precondition may not target
 * one: a {@link RelationCountReq} always carries a `role` (it is a required
 * field), yet a `symmetric` relation's endpoints are an unordered pair for which
 * "from"/"to" is meaningless. Rather than silently accept an incoherent role, we
 * take the stricter safe option and reject ANY relation-count precondition on a
 * symmetric relation type in this release.
 */

import type { EntityTypeDef, RelationTypeDef, RelationCountReq } from "./types.js";
import { assert, lifecycleStates } from "./validate-helpers.js";

/** The minimum meaningful required instance count: at least one relation. */
const MIN_RELATION_COUNT = 1;

/** Rule 7: `minCount` must be a finite integer >= {@link MIN_RELATION_COUNT}. */
function assertMinCount(where: string, minCount: number): void {
  assert(
    Number.isInteger(minCount) && minCount >= MIN_RELATION_COUNT,
    `${where} minCount must be a finite integer >= ${MIN_RELATION_COUNT}`,
  );
}

/**
 * Rule 6: an explicit `otherTypes` must be non-empty (an empty list matches no
 * entity type) and every entry must be a DECLARED entity AND a legal endpoint on
 * the OPPOSITE side of the relation. An omitted `otherTypes` means "any" and is
 * left untouched.
 */
function assertOtherTypes(where: string, req: RelationCountReq, otherSide: string[], entities: Set<string>): void {
  if (req.otherTypes === undefined) return;
  assert(req.otherTypes.length > 0, `${where} declares an empty 'otherTypes' — it would match no entity type`);
  const legalOpposite = new Set(otherSide);
  for (const other of req.otherTypes) {
    assert(entities.has(other), `${where} otherTypes entry '${other}' is not a declared entity type`);
    assert(
      legalOpposite.has(other),
      `${where} otherTypes entry '${other}' is not a legal opposite-side endpoint of relation type '${req.relationType}'`,
    );
  }
}

/**
 * Rule 8: an explicit `otherStates` must be non-empty and duplicate-free, each
 * entry must be a DECLARED lifecycle state of at least one of the requirement's
 * allowed OTHER endpoint types (`otherTypes` when set, else every legal
 * opposite-side type), and at least one allowed other type must declare a
 * lifecycle at all — otherwise the filter can never match and the count is
 * always 0. An omitted `otherStates` means "any state" and is left untouched.
 */
function assertOtherStates(
  where: string,
  req: RelationCountReq,
  otherSide: string[],
  entities: Record<string, EntityTypeDef>,
): void {
  if (req.otherStates === undefined) return;
  assert(req.otherStates.length > 0, `${where} declares an empty 'otherStates' — it would match no lifecycle state`);
  assert(new Set(req.otherStates).size === req.otherStates.length, `${where} declares duplicate 'otherStates' entries`);
  const allowedOthers = req.otherTypes ?? otherSide;
  const declaredStates = new Set<string>();
  for (const other of allowedOthers) {
    const lc = entities[other]?.lifecycle;
    if (lc !== undefined) for (const state of lifecycleStates(lc)) declaredStates.add(state);
  }
  assert(
    declaredStates.size > 0,
    `${where} declares 'otherStates' but no allowed other endpoint type declares a lifecycle — the filter is unsatisfiable`,
  );
  for (const state of req.otherStates) {
    assert(
      declaredStates.has(state),
      `${where} otherStates entry '${state}' is not a declared lifecycle state of any allowed other endpoint type`,
    );
  }
}

/**
 * Validate one {@link RelationCountReq} against the profile's relations and entity
 * types. Rules 2–8: the relation type must be declared; `role` must be
 * `from`/`to`; the relation must not be symmetric (role is incoherent there);
 * this entity must be a legal `role`-side endpoint (else the count is always 0);
 * `otherTypes` must be legal opposite-side endpoints; `minCount` must be a
 * finite integer >= 1; and `otherStates` must be a satisfiable state filter
 * (see {@link assertOtherStates}).
 */
function assertRelationCountReq(
  entityType: string,
  where: string,
  req: RelationCountReq,
  relations: Record<string, RelationTypeDef> | undefined,
  entities: Record<string, EntityTypeDef>,
): void {
  const rel = relations?.[req.relationType];
  assert(rel !== undefined, `${where} references relation type '${req.relationType}', which is not a declared relation type`);
  assert(req.role === "from" || req.role === "to", `${where} has an invalid role '${String(req.role)}' — must be 'from' or 'to'`);
  assert(rel.direction !== "symmetric", `${where} targets symmetric relation type '${req.relationType}' — a role is incoherent for a symmetric relation`);
  const ownSide = req.role === "from" ? rel.from : rel.to;
  const otherSide = req.role === "from" ? rel.to : rel.from;
  assert(
    ownSide.includes(entityType),
    `${where} entity type '${entityType}' is not a legal '${req.role}'-side endpoint of relation type '${req.relationType}' — the count would always be 0`,
  );
  assertOtherTypes(where, req, otherSide, new Set(Object.keys(entities)));
  assertOtherStates(where, req, otherSide, entities);
  assertMinCount(where, req.minCount);
}

/**
 * Validate every entity type's optional `transitionRelationRequirements` block
 * (fail-closed, rule 1 + delegated rules 2–8). For each `[state, reqs]` entry:
 * `state` must be a DECLARED lifecycle state (mirrors how `transitionRequirements`
 * keys are checked), and each requirement in `reqs` must be well-formed and
 * satisfiable (see {@link assertRelationCountReq}). An entity without a lifecycle,
 * or a lifecycle without this key, is skipped — omitted-for-default.
 */
export function assertRelationRequirementsDeclared(
  entities: Record<string, EntityTypeDef>,
  relations: Record<string, RelationTypeDef> | undefined,
): void {
  for (const [entityType, def] of Object.entries(entities)) {
    const lc = def.lifecycle;
    if (!lc?.transitionRelationRequirements) continue;
    const states = lifecycleStates(lc);
    for (const [state, reqs] of Object.entries(lc.transitionRelationRequirements)) {
      const where = `entity '${entityType}' lifecycle transitionRelationRequirements['${state}']`;
      assert(states.has(state), `entity '${entityType}' lifecycle transitionRelationRequirements references unknown state '${state}'`);
      for (const req of reqs) assertRelationCountReq(entityType, where, req, relations, entities);
    }
  }
}
