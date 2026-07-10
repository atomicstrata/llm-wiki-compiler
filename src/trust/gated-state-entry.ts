/**
 * @file src/trust/gated-state-entry.ts
 * @description The ONE precondition seam every write that moves an entity INTO a
 * lifecycle state must call: relation-count and artifact-existence preconditions for
 * the entered state. Both {@link validateLiveTypedPage} (full-page-body writes) and
 * {@link applyLifecycleLocked} (the lifecycle-transition mutation kind) route through
 * here, so a new state-entry precondition can never again be wired into one path and
 * missed on the other (the post-lock audit's Critical). Lock-free: both enforcers only
 * read, under the caller's already-held project lock.
 *
 * DENY BEATS PARK (D-C.1): the two enforcers run relation-then-artifact, but the seam
 * surfaces the WORST of their two outcomes, not whichever throws first. Outcomes rank
 * any Unmet (hard denial) > any Unverifiable (park/retry) > pass, with relation taking
 * precedence over artifact within a tier. Without this, a held relation park could
 * preempt a genuine artifact denial, so a run with a real violation would park/retry
 * forever instead of hard-failing. A relation Unmet still short-circuits (the artifact
 * enforcer need not run — nothing beats a denial), but a relation park no longer
 * preempts an artifact denial discovered afterward.
 */
import {
  RelationPreconditionUnmetError,
  RelationPreconditionUnverifiableError,
  enforceRelationPreconditions,
} from "../relations/enforce-precondition.js";
import {
  ArtifactPreconditionUnmetError,
  ArtifactPreconditionUnverifiableError,
  enforceArtifactPreconditions,
} from "../artifacts/enforce-precondition.js";
import type { LifecycleDef, ProfilePack } from "../profile/types.js";

/** Inputs to {@link enforceGatedStateEntry}; the caller has already resolved `enteredState` to a real state string. */
export interface GatedStateEntryInput {
  root: string;
  profile: ProfilePack;
  entityType: string;
  slug: string;
  enteredState: string;
  lifecycle: LifecycleDef;
  meta: Record<string, unknown>;
}

/**
 * Run `fn`; resolve to `undefined` on success, or to the thrown error IFF it is one
 * of the four known precondition types (a captured outcome to be ranked). Any OTHER
 * error is a genuine bug, not an outcome to prioritize — it rethrows immediately so
 * this seam never swallows it.
 */
async function capturePrecondition(fn: () => Promise<void>): Promise<Error | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    if (
      err instanceof RelationPreconditionUnmetError ||
      err instanceof RelationPreconditionUnverifiableError ||
      err instanceof ArtifactPreconditionUnmetError ||
      err instanceof ArtifactPreconditionUnverifiableError
    ) {
      return err;
    }
    throw err;
  }
}

/**
 * Enforce every precondition for ENTERING `enteredState`: relation-count and
 * artifact-existence. Returns normally only when BOTH pass; otherwise throws the
 * WORST captured outcome (deny beats park — see the file overview).
 * @throws {RelationPreconditionUnmetError|RelationPreconditionUnverifiableError}
 * @throws {ArtifactPreconditionUnmetError|ArtifactPreconditionUnverifiableError}
 */
export async function enforceGatedStateEntry(input: GatedStateEntryInput): Promise<void> {
  const { root, profile, entityType, slug, enteredState, lifecycle, meta } = input;
  const relationError = await capturePrecondition(() =>
    enforceRelationPreconditions({ root, profile, entityType, slug, enteredState, lifecycle }),
  );
  // Nothing beats a relation denial — the artifact enforcer need not run.
  if (relationError instanceof RelationPreconditionUnmetError) throw relationError;

  const artifactError = await capturePrecondition(() =>
    enforceArtifactPreconditions({ root, profile, entityType, slug, enteredState, lifecycle, meta }),
  );
  // An artifact denial beats a held relation park — THE fix.
  if (artifactError instanceof ArtifactPreconditionUnmetError) throw artifactError;
  if (relationError instanceof RelationPreconditionUnverifiableError) throw relationError;
  if (artifactError instanceof ArtifactPreconditionUnverifiableError) throw artifactError;
}
