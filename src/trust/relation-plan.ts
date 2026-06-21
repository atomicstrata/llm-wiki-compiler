/**
 * @file src/trust/relation-plan.ts
 * @description The RELATION write planner — the relation-store analogue of the
 * page {@link planPageMutation}. It routes a proposed relation write through ONE
 * planner decision (CLP Invariant 4): it runs the mandatory relation checks
 * (endpoint validity against the profile relation-type def + required attributes)
 * and composes a {@link TrustDecision} via the SAME {@link composeTrustDecision}
 * the page path uses.
 *
 * This DOES NOT touch disk and mints no id — it is a pure decision over the
 * proposed relation. It RE-VALIDATES exactly what the store
 * ({@link appendRelationLocked}) also enforces, so it is defense in depth plus a
 * uniform decision shared by every surface: a relation write that the planner
 * would deny never reaches the store, and the store stays the final fail-closed
 * floor for a hand-built append that bypassed the planner.
 *
 * The relation surface is NOT review-routed, so a `block` composes to `deny`
 * (never `stage-for-review`): relation staging is out of scope for this slice.
 */

import { composeTrustDecision, type TrustDecision, type TrustCheckResult } from "./decision.js";
import { parseEntityId, EntityIdError } from "../profile/identity.js";
import { validateRelationAttributes } from "../relations/relation-contract.js";
import type { ProfilePack, RelationTypeDef } from "../profile/types.js";
import type { AppendRelationInput } from "../relations/store.js";

/** The planner's output for a relation write: the composed decision + raw checks. */
export interface RelationPlanResult {
  decision: TrustDecision;
  checks: TrustCheckResult[];
}

/** Build a passing check result for a named relation check. */
function pass(code: string, message: string): TrustCheckResult {
  return { code, verdict: "pass", message };
}

/** Build a blocking check result for a named relation check. */
function block(code: string, message: string): TrustCheckResult {
  return { code, verdict: "block", message };
}

/**
 * Check the relation type is declared by the profile. A relation write against a
 * type that `profile.relations` does not declare yields a `block` (no def to
 * validate endpoints/attributes against), mirroring the store's `relationDef`
 * fail-closed throw — but as a uniform decision rather than an exception.
 */
function checkRelationTypeDeclared(profile: ProfilePack, type: string): TrustCheckResult {
  const code = "unknown-relation-type";
  if (profile.relations?.[type]) return pass(code, `relation type '${type}' is declared`);
  return block(code, `unknown relation type '${type}'`);
}

/**
 * Check one endpoint's entity type is allowed on its side of the relation. A
 * non-`<type>/<slug>` id, or an endpoint whose entity type is outside the def's
 * declared `from`/`to` set, yields a `block` — the planner counterpart to the
 * store's `assertEndpoint`.
 */
function checkEndpoint(
  id: string,
  allowed: string[],
  side: "from" | "to",
  type: string,
): TrustCheckResult {
  const code = `relation-endpoint-${side}`;
  let entityType: string;
  try {
    ({ entityType } = parseEntityId(id as never));
  } catch (err) {
    if (err instanceof EntityIdError) return block(code, `relation '${type}' ${side} endpoint id is invalid: ${id}`);
    throw err;
  }
  if (allowed.includes(entityType)) return pass(code, `relation '${type}' ${side} endpoint type '${entityType}' is allowed`);
  return block(code, `relation '${type}' ${side} endpoint type '${entityType}' is not allowed`);
}

/**
 * Check the proposed relation's attributes satisfy the relation-type def's
 * declared contract — required-attribute PRESENCE AND each declared attribute's
 * type/enum/min/max (the SAME field contract entity fields enforce, via
 * {@link validateRelationAttributes}) — the planner counterpart to the store's
 * `assertAttributesValid`. Any violation yields a `block`.
 */
function checkAttributes(def: RelationTypeDef, input: AppendRelationInput): TrustCheckResult {
  const code = "relation-attribute-contract";
  const violations = validateRelationAttributes(def, input.attributes ?? {});
  if (violations.length === 0) return pass(code, "relation attributes satisfy the declared contract");
  return block(code, `relation '${input.type}' has invalid attributes: ${violations.join(" ")}`);
}

/**
 * Run every mandatory relation check, in evaluation order. When the relation type
 * is undeclared the endpoint/attribute checks have no def to run against, so only
 * the type check is returned (it already blocks).
 */
function runMandatoryRelationChecks(profile: ProfilePack, input: AppendRelationInput): TrustCheckResult[] {
  const typeCheck = checkRelationTypeDeclared(profile, input.type);
  const def = profile.relations?.[input.type];
  if (!def) return [typeCheck];
  return [
    typeCheck,
    checkEndpoint(input.from, def.from, "from", input.type),
    checkEndpoint(input.to, def.to, "to", input.type),
    checkAttributes(def, input),
  ];
}

/**
 * Plan a single relation write: run the mandatory relation checks (type declared,
 * endpoint entity types allowed, required attributes present) and compose them
 * into one {@link TrustDecision}. NOTHING is written and no id is minted — the
 * caller ({@link createRelation}) only proceeds to the store on a live-write
 * decision. The relation surface is not review-routed, so a `block` composes to
 * `deny`.
 *
 * @param profile - The governing profile pack (its `relations` block is the schema).
 * @param input - The proposed relation write.
 * @returns The composed decision and the per-check results.
 */
export function planRelationMutation(profile: ProfilePack, input: AppendRelationInput): RelationPlanResult {
  const checks = runMandatoryRelationChecks(profile, input);
  const decision = composeTrustDecision(checks, { reviewRouted: false });
  return { decision, checks };
}
