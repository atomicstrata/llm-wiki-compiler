/**
 * @file src/trust/relation-write.ts
 * @description The trust-gated RELATION WRITE entry point — shared by the SDK and CLI.
 *
 * Relations use a SEPARATE STORE (their own append-only `relations.jsonl`, not
 * journalled and not atomic with page writes), but they are now a REAL executor
 * KIND: {@link createRelation} routes a `relation` {@link RelationPlannedMutation}
 * through the SAME planner→executor seam the page path uses, calling the lock-free
 * core {@link applyApprovedMutationsLocked} inside ONE bounded-blocking lock so
 * concurrent writers serialize rather than spuriously fail. This is one of the
 * public mutation surfaces (with compile/import/refresh/review-approve/
 * transitionLifecycle) that share THAT ONE executor seam — there is no bespoke
 * relation-write helper anymore. "One seam" is a unified dispatch + authority +
 * audit path; it is NOT a cross-store all-or-none claim (the relation record and
 * its audit event are separate stores — see the residual in `relation-apply.ts`).
 *
 * The caller-supplied profile is NOT trusted: the executor's relation handler
 * ({@link applyRelationLocked}) is the UNDER-LOCK authority — it re-loads the
 * active profile, re-plans, re-composes the decision, and (only on a live-write
 * decision) appends, throwing {@link RelationWriteDeniedError} otherwise. That
 * error is DEFINED in `relation-apply.ts` (so the handler can throw it without a
 * relation-write import cycle) and RE-EXPORTED here for existing importers.
 */

import { acquireLockBlocking, releaseLock } from "../utils/lock.js";
import { type AppendRelationInput } from "../relations/store.js";
import { applyApprovedMutationsLocked } from "./executor.js";
import { loadNonDefaultProfile } from "../profile/block.js";
import type { RelationPlannedMutation } from "./planner.js";
import type { ProfilePack } from "../profile/types.js";
import type { RelationRef } from "../relations/types.js";

// Re-exported (not redefined) so existing importers/tests resolve it from here
// while the handler in relation-apply.ts owns the definition — this avoids the
// executor↔relation-write import cycle (relation-apply must NOT import this file).
export { RelationWriteDeniedError } from "./relation-apply.js";

/**
 * Create a relation through the planner→executor seam. The caller's `profile` is
 * IGNORED by the authority (kept in the signature for source compatibility): the
 * executor's relation handler re-loads the on-disk profile UNDER THE LOCK,
 * re-plans, and re-composes the decision. This wrapper takes the bounded-blocking
 * project lock ONCE (so concurrent writers serialize, not fail) and calls the
 * LOCKED executor core directly — never the self-locking {@link applyApprovedMutations}
 * (which would deadlock on a nested acquire) — releasing in `finally`. A
 * non-live-write decision surfaces as a {@link RelationWriteDeniedError} from the
 * handler; nothing is written.
 *
 * @param root - Absolute project root.
 * @param _profile - IGNORED; the under-lock handler re-loads the on-disk profile.
 * @param input - The relation to create.
 * @returns The persisted {@link RelationRef}.
 * @throws {RelationWriteDeniedError} When the recomposed decision denies the write.
 */
export async function createRelation(
  root: string,
  _profile: ProfilePack,
  input: AppendRelationInput,
): Promise<RelationRef> {
  const mutation: RelationPlannedMutation = { kind: "relation", operation: "create", input };
  await acquireLockBlocking(root); // PRESERVE bounded-blocking serialization; throws LockBusyError on timeout
  try {
    const [result] = await applyApprovedMutationsLocked(root, [mutation]); // the LOCKED core (NOT the self-locking wrapper)
    if (result?.kind !== "relation") {
      throw new Error("executor returned a non-relation result for a relation batch");
    }
    return result.ref;
  } finally {
    await releaseLock(root);
  }
}

/**
 * @experimental
 * Thrown when the SDK relation-write entry point is called on a project that has
 * NO non-default profile. Relations are declared only by a non-default profile's
 * `relations` block, so a default project cannot write one. Fails CLOSED before
 * any planning or I/O.
 */
export class RelationsRequireProfileError extends Error {
  constructor() {
    super("relation writes require a non-default profile; this project has none");
    this.name = "RelationsRequireProfileError";
  }
}

/**
 * @experimental
 * SDK entry point for creating a relation: loads the active non-default profile
 * INTERNALLY (throwing {@link RelationsRequireProfileError} when the project has
 * none) and delegates to {@link createRelation}. The caller never passes a
 * {@link ProfilePack} — the SDK owns it. A default project (no `relations`) cannot
 * call this meaningfully: with no non-default profile it throws here, and any
 * declared-but-absent relation type is denied by {@link createRelation}.
 *
 * @param root - Absolute project root.
 * @param input - The relation to create (no profile; the SDK loads it).
 * @returns The persisted {@link RelationRef}.
 * @throws {RelationsRequireProfileError} When the project has no non-default profile.
 * @throws {RelationWriteDeniedError} When the planner denies the write.
 */
export async function createRelationForProject(
  root: string,
  input: AppendRelationInput,
): Promise<RelationRef> {
  const loaded = await loadNonDefaultProfile(root);
  if (!loaded) throw new RelationsRequireProfileError();
  return createRelation(root, loaded.profile, input);
}
