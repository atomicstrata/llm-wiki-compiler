/**
 * @file src/trust/relation-apply.ts
 * @description The RELATION executor handler — the UNDER-LOCK authority for a
 * `relation` PlannedMutation. The dispatcher already holds the lock. Loads the
 * active profile UNDER THE LOCK, re-runs planRelationMutation, re-composes the
 * TrustDecision, fails closed on a non-live-write decision, else appends via the
 * lock-free appendRelationLocked — returning the persisted RelationRef. No
 * pre-lock profile/decision is trusted.
 *
 * CROSS-STORE AUDIT RESIDUAL (honest boundary — no co-commit). The relation
 * record (`relations.jsonl`) and its audit event (the event store) live in
 * SEPARATE stores and are NOT co-committed: `appendRelationLocked` appends the
 * relation record and THEN emits the event, sequentially, with no cross-store
 * journal spanning both. The event store IS pre-flighted under the lock BEFORE
 * the relation append (a tampered/symlinked/too-new store fails the mutation
 * CLOSED with nothing written), so a sick store never lets a relation land. But a
 * store HEALTHY at pre-flight that fails mid-emit AFTER the relation record has
 * landed leaves the relation WITHOUT its audit event — a window closed only by
 * the Phase-5 cross-store op-ID journal. Do NOT read this as all-or-none.
 */
import { appendRelationLocked } from "../relations/store.js";
import { planRelationMutation } from "./relation-plan.js";
import { loadNonDefaultProfile } from "../profile/block.js";
import type { RelationPlannedMutation } from "./planner.js";
import type { RelationRef } from "../relations/types.js";
import type { TrustDecision } from "./decision.js";

/**
 * Thrown when the relation planner reaches a non-live-write decision (an
 * undeclared relation type, a disallowed endpoint entity type, or a missing
 * required attribute). The write fails CLOSED: nothing is appended. Carries the
 * composed `decision` so callers can report exactly how the write was routed.
 *
 * Lives HERE (not in relation-write.ts) so the executor's relation handler can
 * throw it without importing relation-write — relation-write re-exports it for
 * its existing importers, breaking the executor↔relation-write cycle.
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

/** Decisions under which a relation write is cleared to append. */
const LIVE_WRITE_DECISIONS: ReadonlySet<TrustDecision> = new Set(["allow", "allow-with-warning"]);

/**
 * Apply a `relation` mutation WHILE THE CALLER ALREADY HOLDS the project lock —
 * the under-lock authority for the relation kind. The caller-supplied plan is
 * intent only; this handler is the source of truth: it RE-LOADS the active
 * non-default profile UNDER THE LOCK (a project with none cannot declare a
 * relation, so that is a `deny`), RE-RUNS {@link planRelationMutation} against
 * THAT profile, and RE-COMPOSES the decision. A non-live-write decision throws
 * {@link RelationWriteDeniedError} and writes NOTHING; only a live-write decision
 * reaches the lock-free {@link appendRelationLocked}, which records the recomposed
 * decision on the audit event and returns the persisted {@link RelationRef}. The
 * composed `decision` is returned ALONGSIDE the ref so the seam reports the REAL
 * decision (`allow` vs `allow-with-warning`) rather than a hardcoded literal.
 *
 * @param root - Absolute project root (the caller holds its lock).
 * @param mutation - The planned relation mutation (intent only; not trusted).
 * @returns The persisted {@link RelationRef} and the composed live-write decision.
 * @throws {RelationWriteDeniedError} When the recomposed decision is non-live-write.
 */
export async function applyRelationLocked(
  root: string,
  mutation: RelationPlannedMutation,
): Promise<{ ref: RelationRef; decision: TrustDecision }> {
  const loaded = await loadNonDefaultProfile(root);
  if (!loaded) throw new RelationWriteDeniedError(mutation.input.type, "deny");
  const { decision } = planRelationMutation(loaded.profile, mutation.input);
  if (!LIVE_WRITE_DECISIONS.has(decision)) {
    throw new RelationWriteDeniedError(mutation.input.type, decision);
  }
  const ref = await appendRelationLocked(root, loaded.profile, mutation.input, decision);
  return { ref, decision };
}
