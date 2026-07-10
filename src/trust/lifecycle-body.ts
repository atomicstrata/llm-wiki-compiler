/**
 * @file src/trust/lifecycle-body.ts
 * @description The pure evidence allow-listing for a lifecycle transition,
 * extracted from `lifecycle-transition.ts` so the under-lock authority
 * (`lifecycle-apply.ts`) can compose the FINAL frontmatter without importing the
 * SDK entry point (which would form an executor↔lifecycle-apply import cycle).
 *
 * A transition's caller-supplied `evidence` is UNTRUSTED: only the fields the
 * target state declares as required may reach the frontmatter, and never a
 * reserved identity key. Everything else — a `title` clobber, a planted `slug`,
 * arbitrary junk — is dropped here, before the merge.
 */

import type { EntityTypeDef } from "../profile/types.js";

/** Optional evidence fields merged into the page frontmatter for the transition. */
export type LifecycleEvidence = Record<string, unknown>;

/** Frontmatter keys a transition's `evidence` may NEVER set, even if declared. */
const RESERVED_EVIDENCE_KEYS: ReadonlySet<string> = new Set(["slug"]);

/**
 * Reduce caller-supplied `evidence` to ONLY the keys that are legitimately
 * settable for THIS transition: the fields the entity's lifecycle declares as
 * `transitionRequirements[toState]`, MINUS any reserved identity key. Any key the
 * caller passes that is not a declared evidence field for the target state — a
 * `title` clobber, a planted `slug`, arbitrary junk — is DROPPED. When the target
 * state declares no requirements, NO evidence key is admitted.
 *
 * @param def - The (lifecycle-bearing) entity type definition.
 * @param toState - The lifecycle state being transitioned into.
 * @param evidence - The caller-supplied, untrusted evidence map.
 * @returns Only the declared, non-reserved evidence key/value pairs.
 */
export function allowedEvidence(
  def: EntityTypeDef,
  toState: string,
  evidence?: LifecycleEvidence,
): LifecycleEvidence {
  const declared = def.lifecycle!.transitionRequirements?.[toState] ?? [];
  const allowed: LifecycleEvidence = {};
  for (const field of declared) {
    if (RESERVED_EVIDENCE_KEYS.has(field)) continue;
    if (evidence && Object.prototype.hasOwnProperty.call(evidence, field)) allowed[field] = evidence[field];
  }
  return allowed;
}
