/**
 * @file src/trust/typed-page-validate.ts
 * @description The single "validate a typed entity page about to be written LIVE"
 * routine — field contract + lifecycle FSM(prev→next) + relation-count precondition
 * + artifact-existence precondition — shared by BOTH live-apply typed-page paths so
 * they can never drift ("fix every sibling surface"):
 *
 *   - the promote / review-approve path ({@link applyTypedCandidate} in `promote.ts`),
 *   - the workflow `page` stage-output apply path (`applyPageOutput` in
 *     `stage-output.ts`).
 *
 * All three checks are LOCK-FREE reads run under the caller's ALREADY-HELD project
 * lock (this acquires nothing), against the profile the caller loaded UNDER that
 * lock — so no pre-lock TOCTOU is introduced and the two surfaces enforce ONE
 * contract.
 *
 * FAIL-CLOSED, throwing on the FIRST violated check so a page that misses a required
 * field, performs an illegal FSM transition, or would enter a gated state without
 * its qualifying relations or its required artifact never lands live:
 *   - {@link EntityFieldContractError} — a missing required field / type / enum /
 *     range violation (a HARD denial).
 *   - {@link LifecycleTransitionError} — an undeclared state, illegal transition,
 *     or missing required evidence (a HARD denial).
 *   - {@link RelationPreconditionUnmetError} — a gated state entered without its
 *     required relation count (a HARD denial).
 *   - {@link RelationPreconditionUnverifiableError} — the relation store was
 *     unreadable, so the precondition could not be verified (TRANSIENT: a caller
 *     PARKS/retries rather than terminally failing the run).
 *   - {@link ArtifactPreconditionUnmetError} — a gated state entered without a
 *     healthy pinned artifact (absent / confirmed-violation) (a HARD denial).
 *   - {@link ArtifactPreconditionUnverifiableError} — the required artifact could
 *     not be verified (unreadable / genuine store fault), so the precondition could
 *     not be checked (TRANSIENT: a caller PARKS/retries rather than terminally failing).
 */

import { parseFrontmatter } from "../utils/markdown.js";
import { assertBodyWithinResourceLimit } from "./checks.js";
import { EntityFieldContractError } from "../profile/field-contract.js";
import { entityFieldViolations } from "../profile/artifact-ref-validate.js";
import { validateLifecycleTransition, LifecycleTransitionError } from "../profile/lifecycle.js";
import { readPrevLifecycleState } from "../profile/lifecycle-read.js";
import { enforceGatedStateEntry } from "./gated-state-entry.js";
import type { EntityTypeDef, ProfilePack } from "../profile/types.js";

/** Inputs to {@link validateLiveTypedPage}; grouped to keep the arg list small. */
export interface LiveTypedPageValidationInput {
  /** Absolute project root (the CALLER already holds its lock). */
  root: string;
  /** The active profile, ALREADY loaded under the held lock (not re-loaded here). */
  profile: ProfilePack;
  /** The (already type-checked) profile entity type the page belongs to. */
  entityType: string;
  /** The page slug (filename stem + prev-state read + error context). */
  slug: string;
  /** The full markdown body (frontmatter + prose) about to be written live. */
  body: string;
  /** The resolved entity type definition supplying the contract + lifecycle. */
  def: EntityTypeDef;
}

/**
 * Validate a body's frontmatter against the entity type's declared field contract
 * via the SHARED {@link entityFieldViolations} (field contract + profile-aware
 * artifactRef scope), throwing {@link EntityFieldContractError} on any violation.
 * The raw body-length cap is enforced FIRST (before the parse) so a giant
 * all-frontmatter body is rejected by `.length` alone — the "reject before
 * parsing" guarantee. Returns the parsed frontmatter so the caller reuses it rather
 * than re-parsing. Exported so the SDK staging gate (`staging.ts`, a NON-live park)
 * and the live-apply paths share ONE field-contract check (DRY).
 *
 * @throws {ResourceLimitError} When the body exceeds the resource cap.
 * @throws {EntityFieldContractError} When the frontmatter violates the contract.
 */
export function assertBodyFieldContract(
  profile: ProfilePack,
  entityType: string,
  slug: string,
  body: string,
  def: EntityTypeDef,
): Record<string, unknown> {
  assertBodyWithinResourceLimit(body);
  const { meta } = parseFrontmatter(body);
  const violations = entityFieldViolations(profile, meta, def);
  if (violations.length > 0) throw new EntityFieldContractError(entityType, slug, violations);
  return meta;
}

/**
 * Validate a body's lifecycle transition (prev→next) via the SHARED
 * {@link validateLifecycleTransition}, throwing {@link LifecycleTransitionError} on
 * an undeclared state, an illegal transition from the on-disk prev state, or a
 * missing required evidence field. An entity type with NO declared `lifecycle` is a
 * no-op. The `prev` state is read path-confined from the existing page (a create
 * reads `undefined`). Exported so the SDK staging gate and the live-apply paths
 * share ONE FSM check (DRY).
 *
 * @throws {LifecycleTransitionError} When the lifecycle transition is illegal.
 */
export async function assertBodyLifecycle(
  root: string,
  entityType: string,
  slug: string,
  meta: Record<string, unknown>,
  def: EntityTypeDef,
): Promise<void> {
  const lifecycle = def.lifecycle;
  if (!lifecycle) return;
  const prev = await readPrevLifecycleState(root, def, slug, lifecycle.field);
  const problems = validateLifecycleTransition(lifecycle, prev, meta[lifecycle.field], meta);
  if (problems.length > 0) throw new LifecycleTransitionError(entityType, slug, problems);
}

/**
 * The lifecycle state the body ENTERS, or `undefined` when there is nothing to
 * enforce: a type with NO declared lifecycle, or a body whose lifecycle field
 * carries no string value. Shared by the relation + artifact precondition helpers so
 * their identical "is this even a gated write?" guard is spelled ONCE (DRY) — each
 * enforcer itself further early-outs when the entered state declares no requirement.
 */
function enteredLifecycleState(meta: Record<string, unknown>, def: EntityTypeDef): string | undefined {
  if (!def.lifecycle) return undefined;
  const enteredState = meta[def.lifecycle.field];
  return typeof enteredState === "string" ? enteredState : undefined;
}

/**
 * Validate a typed entity page about to be written LIVE: the field contract, then
 * the lifecycle FSM(prev→next), then — for a body ENTERING a lifecycle state — the
 * relation-count then artifact-existence preconditions via the shared
 * {@link enforceGatedStateEntry} seam (the SAME seam {@link applyLifecycleLocked}
 * routes through, so the two state-entry paths cannot drift). The ONE routine BOTH
 * live-apply typed-page paths call. LOCK-FREE (the caller holds the lock; every check
 * reads without acquiring). Throws on the first violated check with nothing written;
 * see the file overview for the fail-closed error taxonomy.
 *
 * @param input - Root, the under-lock-loaded profile, entity type/slug, body, and def.
 * @throws {EntityFieldContractError} When the frontmatter violates the field contract.
 * @throws {LifecycleTransitionError} When the lifecycle transition is illegal.
 * @throws {RelationPreconditionUnmetError} When a relation-count precondition is unmet.
 * @throws {RelationPreconditionUnverifiableError} When the relation store is unreadable.
 * @throws {ArtifactPreconditionUnmetError} When a required artifact is absent or violated.
 * @throws {ArtifactPreconditionUnverifiableError} When a required artifact is unverifiable.
 */
export async function validateLiveTypedPage(input: LiveTypedPageValidationInput): Promise<void> {
  const { root, profile, entityType, slug, body, def } = input;
  const meta = assertBodyFieldContract(profile, entityType, slug, body, def);
  await assertBodyLifecycle(root, entityType, slug, meta, def);
  const enteredState = enteredLifecycleState(meta, def);
  if (enteredState !== undefined) {
    await enforceGatedStateEntry({ root, profile, entityType, slug, enteredState, lifecycle: def.lifecycle!, meta });
  }
}
