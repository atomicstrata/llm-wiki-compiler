/**
 * @file src/preparations/attempts/start.ts
 * @description Leg C/D of the three-leg protocol: seal the exact authority under
 * the project lock and project the durable `intent-recorded` fact (design
 * sections 15.2, 15.3). Sealing canonically digests the immutable manifest's
 * plan authorities, executor, exposure, and resolved grant/effect digests into a
 * single recomputable `authoritySnapshotDigest`; that snapshot is the ONLY bridge
 * across the lock-released execution leg, so leg K recomputes it and rejects any
 * drift. The intent projector sets the execution owner and a `running` phase
 * summary; it never changes run state, version, or the transition chain (the run
 * store re-verifies that invariant before signing).
 */

import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import { deepCaptureData } from "../../utils/runtime-capture.js";
import { parseSha256Digest } from "../../capability-providers/ids.js";
import type { PreparationManifestV1 } from "../manifest-parse.js";
import type { PreparationRunContentProjector } from "../run-store.js";
import type { PhaseBoundsV1, PhaseExecutorV1 } from "../plan-types.js";
import type { PhaseSummaryV1, PreparationExecutionOwnerV1 } from "../run-types.js";
import type { Sha256Digest } from "../types.js";
import type {
  AttemptLeaseV1, SealAuthorityExtrasV1, SealedAttemptContextV1, SealedAuthorityV1,
} from "./types.js";
import { leaseExecutionOwner } from "./lease.js";
import type { AttemptId, PhaseInstanceId } from "../ids.js";

const AUTHORITY_SNAPSHOT_DOMAIN = "llmwiki-preparation-attempt-authority-v1";

/** Compute the exact sealed authority bundle from the immutable manifest. */
export function computeSealedAuthority(
  manifest: PreparationManifestV1, executor: PhaseExecutorV1, extras: SealAuthorityExtrasV1,
): SealedAuthorityV1 {
  const plan = manifest.plan;
  return {
    manifestDigest: parseSha256Digest(canonicalDigestOf(manifest)),
    planDigest: manifest.planDigest,
    knowledgeAuthorityDigest: plan.knowledgeAuthority.digest,
    operationsAuthorityDigest: plan.operationsAuthority.digest,
    actionDescriptorDigest: plan.actionAuthority.actionDescriptorDigest,
    handlerContractDigest: plan.actionAuthority.handlerContractDigest,
    recipeDigest: plan.recipeDigest,
    safetyFloorDigest: plan.safetyFloorDigest,
    executorDigest: parseSha256Digest(canonicalDigest(executor)),
    inputExposureSetDigest: extras.inputExposureSetDigest,
    ...optionalDigest("grantSnapshotDigest", extras.grantSnapshotDigest),
    ...optionalDigest("providerPinDigest", extras.providerPinDigest),
    ...optionalDigest("effectPlanDigest", extras.effectPlanDigest),
    ...optionalDigest("brokerPlanDigest", extras.brokerPlanDigest),
    ...optionalDigest("backendReadinessDigest", extras.backendReadinessDigest),
  };
}

/** Canonical digest over the whole manifest record (its stored planDigest aside). */
function canonicalDigestOf(manifest: PreparationManifestV1): string {
  return canonicalDigest(manifest);
}

/** Emit an optional digest field only when the caller supplied it. */
function optionalDigest(key: string, value: Sha256Digest | undefined): Record<string, Sha256Digest> {
  return value === undefined ? {} : { [key]: value };
}

/** Bind the sealed authority bundle into one recomputable snapshot digest. */
export function authoritySnapshotDigest(authority: SealedAuthorityV1): Sha256Digest {
  return parseSha256Digest(canonicalDigest({ domain: AUTHORITY_SNAPSHOT_DOMAIN, authority }));
}

/** Seal the complete attempt intent from the re-read manifest and minted lease. */
export function sealAttemptContext(input: {
  manifest: PreparationManifestV1;
  executor: PhaseExecutorV1;
  bounds: PhaseBoundsV1;
  extras: SealAuthorityExtrasV1;
  attemptId: AttemptId;
  phaseInstanceId: PhaseInstanceId;
  logicalPhaseId: string;
  disposition: "required" | "optional";
  lease: AttemptLeaseV1;
  stateVersionAtSeal: number;
}): SealedAttemptContextV1 {
  const authority = computeSealedAuthority(input.manifest, input.executor, input.extras);
  // Deep-capture every value the leg receives or leg-K digests into a fresh,
  // recursively-frozen, data-only tree so the unlocked leg cannot mutate-then-
  // restore a nested field to execute one thing and revalidate another (RC-A).
  return Object.freeze({
    attemptId: input.attemptId, phaseInstanceId: input.phaseInstanceId,
    logicalPhaseId: input.logicalPhaseId, disposition: input.disposition,
    lease: deepCaptureData(input.lease) as AttemptLeaseV1,
    executor: deepCaptureData(input.executor) as PhaseExecutorV1,
    bounds: deepCaptureData(input.bounds) as PhaseBoundsV1,
    authority: deepCaptureData(authority) as SealedAuthorityV1,
    authoritySnapshotDigest: authoritySnapshotDigest(authority),
    stateVersionAtSeal: input.stateVersionAtSeal,
  });
}

/** Replace one phase summary by its phase-instance id, or append it if absent. */
export function upsertPhaseSummary(
  summaries: readonly PhaseSummaryV1[], next: PhaseSummaryV1,
): PhaseSummaryV1[] {
  const kept = summaries.filter((summary) => summary.phaseInstanceId !== next.phaseInstanceId);
  return [...kept, next];
}

/** Build the `running` phase summary recorded when intent is durable. */
function runningPhaseSummary(sealed: SealedAttemptContextV1, attemptCount: number): PhaseSummaryV1 {
  return {
    phaseInstanceId: sealed.phaseInstanceId, logicalPhaseId: sealed.logicalPhaseId,
    state: "running", disposition: sealed.disposition, attemptCount,
    currentAttemptId: sealed.attemptId, invocationCount: 0, brokerRequestCount: 0, effectCount: 0,
  };
}

/** Project the durable intent-recorded fact: execution owner plus running phase. */
export function attemptIntentProjector(
  sealed: SealedAttemptContextV1, attemptCount: number,
): PreparationRunContentProjector {
  const owner: PreparationExecutionOwnerV1 = leaseExecutionOwner(sealed.lease, sealed.attemptId);
  const phase = runningPhaseSummary(sealed, attemptCount);
  return (next) => ({ ...next, executionOwner: owner, phaseSummaries: upsertPhaseSummary(next.phaseSummaries, phase) });
}
