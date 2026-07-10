/**
 * @file src/workflows/hard-denial.ts
 * @description Classify a thrown stage-output error as a HARD DENIAL — the failure
 * mode that should route a run to terminal `failed` (retryable via `resume`).
 *
 * A stage-output submit can fail in two distinct ways, and ONLY one is a dead-end
 * for the attempt:
 *
 *  - A HARD DENIAL is the executor REFUSING the write outright — the write CANNOT
 *    proceed for this attempt. A page `deny` ({@link StageWriteDeniedError}), a
 *    relation denial ({@link RelationWriteDeniedError}), an illegal lifecycle
 *    transition ({@link LifecycleTransitionError}), a trust-gated relation/lifecycle
 *    write with no out-of-band grant ({@link TrustGateRequiresGrantError}), an
 *    artifact write refused for a missing grant ({@link ArtifactWriteRefusedError})
 *    or blocked by a non-live decision ({@link ArtifactWriteDeniedError}), a workflow
 *    artifact re-run diverging from already-written bytes
 *    ({@link WorkflowArtifactChangedError}) or whose immutability could not be verified
 *    because the existing manifest was unreadable/malformed
 *    ({@link WorkflowArtifactUnverifiableError}), or —
 *    for a typed `page` output — a field-contract violation
 *    ({@link EntityFieldContractError}), a gated state entered without its required
 *    relations ({@link RelationPreconditionUnmetError}), or a gated state entered
 *    without its required healthy artifact ({@link ArtifactPreconditionUnmetError}).
 *    Such a run, left as-is, would sit `awaiting-output` forever with no path to
 *    retry — so it is routed to `failed`, where `resume` can re-activate it.
 *
 *  - A non-hard outcome is RECOVERABLE in place and must NOT fail the run: a STAGED
 *    page write (`stage-for-review`/`quarantine`, a non-throwing `applied:false`
 *    result — it is pending review, not refused), a scope/idempotency/ownership/
 *    pending/cap guard ({@link StageWriteScopeError}, {@link StageOutputAlreadyAppliedError},
 *    {@link StageOutputPendingError}, …), a transient I/O fault, or an UNVERIFIABLE
 *    relation store ({@link RelationPreconditionUnverifiableError} — "cannot verify",
 *    NOT "refused", so a healthy run PARKS/retries rather than terminally failing), or
 *    an UNVERIFIABLE required artifact ({@link ArtifactPreconditionUnverifiableError} —
 *    unreadable / genuine store fault, likewise "cannot verify", NOT "refused", so it
 *    is NOT listed above and stays non-hard). These leave the run parked/unchanged so
 *    the caller can correct and re-submit.
 *
 * Centralizing the predicate here keeps the "what counts as a dead-end write" rule
 * in EXACTLY ONE place, so the auto-fail routing in `submitStageOutput` and any
 * future caller agree on the boundary.
 */

import { StageWriteDeniedError, TrustGateRequiresGrantError, WorkflowArtifactChangedError, WorkflowArtifactUnverifiableError } from "./errors.js";
import { RelationWriteDeniedError } from "../trust/relation-apply.js";
import { LifecycleTransitionError } from "../profile/lifecycle.js";
import { EntityFieldContractError } from "../profile/field-contract.js";
import { RelationPreconditionUnmetError } from "../relations/enforce-precondition.js";
import { ArtifactPreconditionUnmetError } from "../artifacts/enforce-precondition.js";
import { ArtifactWriteRefusedError, ArtifactWriteDeniedError } from "../artifacts/apply.js";

/**
 * True when `err` is a HARD DENIAL of a stage-output write — the executor REFUSED
 * the write (vs a staged/recoverable outcome). A run hitting one of these is routed
 * to terminal `failed` so it can be retried via `resume` rather than stranded
 * `awaiting-output`. See the file header for the full taxonomy.
 *
 * @param err - The error thrown by a stage-output dispatch.
 * @returns Whether the error is a hard, retry-via-resume denial.
 */
export function isHardDenial(err: unknown): boolean {
  return (
    err instanceof StageWriteDeniedError ||
    err instanceof RelationWriteDeniedError ||
    err instanceof LifecycleTransitionError ||
    err instanceof TrustGateRequiresGrantError ||
    err instanceof EntityFieldContractError ||
    err instanceof RelationPreconditionUnmetError ||
    err instanceof ArtifactPreconditionUnmetError ||
    err instanceof ArtifactWriteRefusedError ||
    err instanceof ArtifactWriteDeniedError ||
    err instanceof WorkflowArtifactChangedError ||
    err instanceof WorkflowArtifactUnverifiableError
  );
}
