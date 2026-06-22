/**
 * @file src/trust/relation-write.ts
 * @description The trust-gated RELATION WRITE entry point — shared by the SDK and CLI.
 *
 * Relations use a SEPARATE write path. It SHARES the trust DECISION composer
 * ({@link composeTrustDecision}, via {@link planRelationMutation}) with the page
 * path, but it does NOT route through the page planner/executor/journal: relation
 * writes are NOT journalled and are NOT atomic with page writes. They have their
 * own append-only durability (a single locked append to `relations.jsonl`).
 *
 * {@link createRelation} plans the relation; on any non-live-write decision it
 * throws a typed {@link RelationWriteDeniedError} and writes NOTHING. Only on
 * `allow`/`allow-with-warning` does it take the project lock ONCE (bounded-blocking,
 * so concurrent writers serialize rather than spuriously fail) and append through
 * the lock-free {@link appendRelationLocked}, releasing in `finally`.
 */

import { acquireLockBlocking, releaseLock } from "../utils/lock.js";
import { appendRelationLocked, type AppendRelationInput } from "../relations/store.js";
import { planRelationMutation } from "./relation-plan.js";
import { loadNonDefaultProfile } from "../profile/block.js";
import type { TrustDecision } from "./decision.js";
import type { ProfilePack } from "../profile/types.js";
import type { RelationRef } from "../relations/types.js";

/** Decisions under which a relation write is cleared to append. */
const LIVE_WRITE_DECISIONS: ReadonlySet<TrustDecision> = new Set(["allow", "allow-with-warning"]);

/**
 * Thrown when the relation planner reaches a non-live-write decision (an
 * undeclared relation type, a disallowed endpoint entity type, or a missing
 * required attribute). The write fails CLOSED: nothing is appended. Carries the
 * composed `decision` so callers can report exactly how the write was routed.
 */
export class RelationWriteDeniedError extends Error {
  /** The non-live-write decision the planner reached. */
  readonly decision: TrustDecision;

  constructor(type: string, decision: TrustDecision) {
    super(`relation write of type '${type}' denied by the write planner (${decision}); nothing written`);
    this.name = "RelationWriteDeniedError";
    this.decision = decision;
  }
}

/**
 * Create a relation through the trust planner: plan the write, and — only on a
 * live-write decision — acquire the project lock ONCE and append via the
 * lock-free {@link appendRelationLocked}. A non-live-write decision throws
 * {@link RelationWriteDeniedError} BEFORE any lock or write, so a denied relation
 * leaves the store untouched.
 *
 * @param root - Absolute project root.
 * @param profile - The governing profile pack (its `relations` block is the schema).
 * @param input - The relation to create.
 * @returns The persisted {@link RelationRef}.
 * @throws {RelationWriteDeniedError} When the planner denies the write.
 */
export async function createRelation(
  root: string,
  profile: ProfilePack,
  input: AppendRelationInput,
): Promise<RelationRef> {
  const { decision } = planRelationMutation(profile, input);
  if (!LIVE_WRITE_DECISIONS.has(decision)) {
    throw new RelationWriteDeniedError(input.type, decision);
  }
  await acquireLockBlocking(root); // serializes concurrent writers; throws LockBusyError on timeout
  try {
    return await appendRelationLocked(root, profile, input, decision); // record the composed verdict on the audit event (B7)
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
