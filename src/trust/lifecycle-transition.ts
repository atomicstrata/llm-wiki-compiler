/**
 * @file src/trust/lifecycle-transition.ts
 * @description The trust-gated LIFECYCLE TRANSITION entry point, shared by the
 * SDK and CLI — now a thin self-locking wrapper over the executor seam.
 *
 * A lifecycle transition is a REAL executor kind (Task 4): the intent
 * ({@link LifecycleTransitionPlannedMutation}) is dispatched through
 * {@link applyApprovedMutationsLocked}, whose under-lock authority
 * ({@link applyLifecycleLocked}) re-loads the profile, composes a real
 * {@link TrustDecision} over the FINAL frontmatter (FSM transition validity +
 * the typed entity-field contract), writes the page through the SHARED
 * page-apply primitive (page floor + journal inherited), and emits the audit
 * event with the decision recorded TOP-LEVEL.
 *
 * This module's only remaining job is the LOCK: it acquires the project lock
 * (preserving the typed {@link LifecycleTransitionLockError} on contention) so
 * the under-lock handler runs single-writer, and releases it in `finally`. All
 * validation, the page write, and the audit emit live in the handler.
 *
 * This is one of the public mutation surfaces (with compile/import/refresh/
 * review-approve/createRelation) that share THAT ONE executor seam — there is no
 * bespoke lifecycle-write helper anymore. "One seam" is a unified dispatch +
 * authority + audit path; it is NOT a cross-store all-or-none claim (the page
 * write and its audit event are separate stores — see the residual in
 * `lifecycle-apply.ts`).
 *
 * The error classes ({@link LifecycleTransitionUnavailableError},
 * {@link LifecycleTransitionLockError}) live in `lifecycle-apply.ts` to avoid an
 * executor↔lifecycle-apply import cycle; they are RE-EXPORTED here so existing
 * importers keep resolving them from this module.
 */

import { acquireLock, releaseLock } from "../utils/lock.js";
import { applyApprovedMutationsLocked } from "./executor.js";
import { LifecycleTransitionLockError } from "./lifecycle-apply.js";
import type { LifecycleTransitionPlannedMutation } from "./planner.js";
import type { LifecycleEvidence } from "./lifecycle-body.js";

export type { LifecycleEvidence } from "./lifecycle-body.js";
export { LifecycleTransitionLockError, LifecycleTransitionUnavailableError } from "./lifecycle-apply.js";

/**
 * Transition a typed entity page's lifecycle field to `toState` as a validated
 * page update, UNDER THE PROJECT LOCK. Acquires the project lock (throwing
 * {@link LifecycleTransitionLockError} when another process holds it), then
 * dispatches a {@link LifecycleTransitionPlannedMutation} through the executor's
 * under-lock authority — which re-loads the profile, validates the FINAL
 * frontmatter against the FSM + entity-field contract (an illegal transition or
 * one missing required evidence is REFUSED there, the page left unchanged),
 * writes the page via the shared page-apply primitive, and emits the audit event
 * with the composed decision recorded top-level. The lock is always released in
 * `finally`.
 *
 * @param root - Absolute project root.
 * @param entityType - The profile entity type whose page is transitioned.
 * @param slug - The page slug (the filename stem).
 * @param toState - The lifecycle state to transition the page into.
 * @param evidence - Optional frontmatter fields a target state requires (merged in).
 * @throws {LifecycleTransitionUnavailableError} When no profile/lifecycle/page.
 * @throws {LifecycleTransitionLockError} When the project lock cannot be acquired.
 * @throws {LifecycleTransitionError} When the composed decision refuses the transition.
 */
export async function transitionLifecycle(
  root: string,
  entityType: string,
  slug: string,
  toState: string,
  evidence?: LifecycleEvidence,
): Promise<void> {
  const mutation: LifecycleTransitionPlannedMutation = {
    kind: "lifecycle-transition",
    entityType,
    slug,
    toState,
    evidence,
  };
  if (!(await acquireLock(root))) throw new LifecycleTransitionLockError();
  try {
    await applyApprovedMutationsLocked(root, [mutation]);
  } finally {
    await releaseLock(root);
  }
}
