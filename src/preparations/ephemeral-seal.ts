/**
 * @file src/preparations/ephemeral-seal.ts
 * @description Seal ONE ephemeral-read phase against the immutable plan (design
 * sections 7.1, 15.3). An ephemeral read stages no manifest — a manifest is a
 * durable byte — so the immutable authority here is the DEEP-CAPTURED plan
 * snapshot taken before any await: a fresh, frozen, data-only tree that rejects
 * accessors and proxies and shares no reference with the caller. Every authority
 * the execution binds — executor, bounds, disposition, phase identity, capability
 * pin, broker plan, exposure — is derived from that snapshot plus the host-owned
 * authority resolver, never from a caller-supplied executor, digest, or bound.
 * The seal reuses the durable attempt's {@link authoritySnapshotDigest}, so a
 * post-leg re-resolution detects genuine authority drift exactly as leg K does.
 *
 * TRUST MODEL — read this before trusting the word "sealed" here. Unlike a
 * durable attempt, which seals against a STAGED, digest-addressed manifest, an
 * ephemeral read has no stored bytes to authenticate the plan against: the plan
 * is CALLER-SUPPLIED and UNAUTHENTICATED. "Sealed" therefore means exactly
 * "frozen at capture and bound to that immutable snapshot for the whole read" —
 * it does NOT mean the plan's provenance was verified. The host-owned anchors
 * are the authority resolver's answers alone: the installed capability pin, the
 * input exposure set, the broker plan, and the absence of an effect plan. A
 * caller can therefore choose WHICH read-only work runs, but never widen the
 * capability, exposure, broker surface, or effect authority it runs under.
 */

import { canonicalDigest } from "../profile/templates/signing/canonical.js";
import { parseSha256Digest } from "../capability-providers/ids.js";
import { deepCaptureData } from "../utils/runtime-capture.js";
import { deriveAttemptId, derivePhaseInstanceId, singleExpansionIdentity, type PhaseInstanceId } from "./ids.js";
import { mintAttemptLease } from "./attempts/lease.js";
import { authoritySnapshotDigest } from "./attempts/start.js";
import { ephemeralIneligibility } from "./ephemeral.js";
import type {
  NormalizedPhaseV1, NormalizedPreparationPlanV1, PhaseBoundsV1, PhaseExecutorV1,
} from "./plan-types.js";
import type {
  SealAuthorityExtrasV1, SealedAttemptContextV1, SealedAuthorityV1,
} from "./attempts/types.js";
import type { Sha256Digest } from "./types.js";

/** Domain separator for the ephemeral seal identity (no manifest is ever staged). */
const EPHEMERAL_SEAL_DOMAIN = "llmwiki-preparation-ephemeral-seal-v1";

/** One work phase of an ephemeral plan proven to carry an executor. */
export type EphemeralPhaseV1 = NormalizedPhaseV1 & { executor: PhaseExecutorV1 };

/** The two digests identifying one ephemeral seal; no manifest digest exists. */
interface EphemeralIdentityV1 {
  readonly planDigest: Sha256Digest;
  readonly sealDigest: Sha256Digest;
}

/**
 * The plan-derived half of an ephemeral seal: the phase, its stable identity, and
 * the plan digests — everything knowable BEFORE the host resolves the authority,
 * so the resolver can be asked about the exact phase instance it will run.
 */
export interface PreparedEphemeralPhaseV1 {
  readonly phase: EphemeralPhaseV1;
  readonly identity: EphemeralIdentityV1;
  readonly phaseInstanceId: PhaseInstanceId;
}

/** A prepared ephemeral phase, or the fixed reason the read is refused. */
export type PrepareEphemeralResultV1 =
  | { readonly kind: "ok"; readonly prepared: PreparedEphemeralPhaseV1 }
  | { readonly kind: "refused"; readonly reason: string };

/** The sealed ephemeral phase, or the fixed reason the read is refused. */
export type EphemeralSealResultV1 =
  | { readonly kind: "sealed"; readonly sealed: SealedAttemptContextV1 }
  | { readonly kind: "refused"; readonly reason: string };

/** Emit an optional digest field only when the resolver supplied it. */
function optionalDigest(key: string, value: Sha256Digest | undefined): Record<string, Sha256Digest> {
  return value === undefined ? {} : { [key]: value };
}

/**
 * Deep-capture the caller's plan into an immutable data-only tree, or null when
 * it carries an accessor, proxy, or otherwise uncapturable value. Everything the
 * read seals and executes is read from this copy, so a post-capture mutation of
 * the caller's plan cannot change what runs.
 */
export function captureEphemeralPlan(plan: NormalizedPreparationPlanV1): NormalizedPreparationPlanV1 | null {
  try {
    return deepCaptureData(plan) as NormalizedPreparationPlanV1;
  } catch {
    return null;
  }
}

/** Digest the captured plan and derive its domain-separated seal identity. */
function planIdentity(plan: NormalizedPreparationPlanV1): EphemeralIdentityV1 {
  const planDigest = parseSha256Digest(canonicalDigest(plan));
  return {
    planDigest,
    sealDigest: parseSha256Digest(canonicalDigest({ domain: EPHEMERAL_SEAL_DOMAIN, planDigest })),
  };
}

/**
 * Resolve the named phase from the captured plan. Only a single-expansion WORK
 * phase carrying exactly one executor and no gate may run ephemerally — a
 * fail-closed allowlist, not a denylist of the shapes seen so far.
 */
function phaseRefusal(phase: NormalizedPhaseV1): string | null {
  if (phase.role !== "work") return "phase-not-work";
  if (phase.gate !== undefined) return "durable-gate-required";
  if (phase.executor === undefined) return "phase-has-no-executor";
  if (phase.expansion.kind !== "single") return "phase-expansion-not-single";
  if (phase.effectPlanDigest !== undefined) return "external-effect-required";
  return null;
}

/**
 * Bind the requested phase to the plan's DECLARED work: it must be a phase the
 * output contract names as a producer, and it must depend on nothing. An
 * ephemeral read runs exactly ONE phase and never runs that phase's
 * dependencies, so a phase carrying `dependsOn` entries cannot be honestly
 * executed — its inputs would be absent while the provider ran anyway — and a
 * phase outside `producingPhaseIds` is not a read of a declared output at all.
 */
function phaseRunsAlone(plan: NormalizedPreparationPlanV1, phase: NormalizedPhaseV1): string | null {
  if (!plan.outputContract.producingPhaseIds.includes(phase.logicalPhaseId)) return "phase-not-declared-producer";
  return phase.dependsOn.length > 0 ? "phase-dependencies-unsatisfied" : null;
}

/**
 * Prove the plan is ephemeral-read-shape eligible, resolve the named phase, and
 * derive its stable identity. This half depends only on the immutable plan, so
 * re-running it after the leg proves the phase itself never drifted.
 */
export function prepareEphemeralPhase(
  plan: NormalizedPreparationPlanV1, logicalPhaseId: string,
): PrepareEphemeralResultV1 {
  const ineligible = ephemeralIneligibility(plan);
  if (ineligible !== null) return { kind: "refused", reason: ineligible };
  const phase = plan.phases.find((candidate) => candidate.logicalPhaseId === logicalPhaseId);
  if (phase === undefined) return { kind: "refused", reason: "phase-not-in-plan" };
  const refusal = phaseRefusal(phase) ?? phaseRunsAlone(plan, phase);
  if (refusal !== null) return { kind: "refused", reason: refusal };
  const identity = planIdentity(plan);
  const phaseInstanceId = derivePhaseInstanceId({
    manifestDigest: identity.sealDigest, logicalPhaseId: phase.logicalPhaseId,
    expansionIdentity: singleExpansionIdentity(),
  });
  return { kind: "ok", prepared: { phase: phase as EphemeralPhaseV1, identity, phaseInstanceId } };
}

/**
 * Bind the resolved capability pin to the sealed executor with SYMMETRIC
 * presence and absence: a provider phase must have an authoritative installed
 * pin equal to the plan's pinned digest (section 7.1 requires the package to be
 * already available), and a host-handler phase must carry no provider pin at all.
 */
function pinBindsExecutor(executor: PhaseExecutorV1, extras: SealAuthorityExtrasV1): string | null {
  if (executor.kind !== "provider-capability") {
    return extras.providerPinDigest === undefined ? null : "provider-pin-unexpected";
  }
  if (extras.providerPinDigest === undefined) return "provider-pin-unavailable";
  return extras.providerPinDigest === executor.providerPinDigest ? null : "provider-pin-drift";
}

/**
 * Bind the resolved authority to the sealed phase: an ephemeral read may never
 * carry an effect plan, and the resolved broker plan must be exactly the phase's
 * declared one (symmetric, so neither an extra nor a missing plan passes).
 */
function authorityBindsPhase(prepared: PreparedEphemeralPhaseV1, extras: SealAuthorityExtrasV1): string | null {
  if (extras.effectPlanDigest !== undefined) return "external-effect-required";
  return prepared.phase.brokerPlanDigest === extras.brokerPlanDigest ? null : "broker-plan-drift";
}

/** The first reason the resolved authority does not bind the prepared phase. */
function authorityRefusal(prepared: PreparedEphemeralPhaseV1, extras: SealAuthorityExtrasV1): string | null {
  return pinBindsExecutor(prepared.phase.executor, extras) ?? authorityBindsPhase(prepared, extras);
}

/**
 * Compute the exact sealed authority from the captured plan and resolved extras.
 * `manifestDigest` carries the ephemeral SEAL identity because no manifest is
 * staged; it is never compared against stored bytes and nothing durable
 * references it. No `effectPlanDigest` is ever emitted, which is what makes the
 * provider leg's symmetric check reject any invocation carrying an effect plan.
 */
function ephemeralAuthority(
  plan: NormalizedPreparationPlanV1, prepared: PreparedEphemeralPhaseV1, extras: SealAuthorityExtrasV1,
): SealedAuthorityV1 {
  return {
    manifestDigest: prepared.identity.sealDigest,
    planDigest: prepared.identity.planDigest,
    knowledgeAuthorityDigest: plan.knowledgeAuthority.digest,
    operationsAuthorityDigest: plan.operationsAuthority.digest,
    actionDescriptorDigest: plan.actionAuthority.actionDescriptorDigest,
    handlerContractDigest: plan.actionAuthority.handlerContractDigest,
    recipeDigest: plan.recipeDigest,
    safetyFloorDigest: plan.safetyFloorDigest,
    executorDigest: parseSha256Digest(canonicalDigest(prepared.phase.executor)),
    inputExposureSetDigest: extras.inputExposureSetDigest,
    ...optionalDigest("grantSnapshotDigest", extras.grantSnapshotDigest),
    ...optionalDigest("providerPinDigest", extras.providerPinDigest),
    ...optionalDigest("brokerPlanDigest", extras.brokerPlanDigest),
    ...optionalDigest("backendReadinessDigest", extras.backendReadinessDigest),
  };
}

/**
 * Seal the prepared phase: bind every authority dimension, then freeze the
 * deep-captured executor, bounds, and authority into the sealed context the
 * hardened attempt legs consume. `stateVersionAtSeal` is a fixed 0 because no
 * durable run exists to version.
 */
export function sealEphemeralPhase(input: {
  plan: NormalizedPreparationPlanV1;
  prepared: PreparedEphemeralPhaseV1;
  extras: SealAuthorityExtrasV1;
  now: string;
}): EphemeralSealResultV1 {
  const refusal = authorityRefusal(input.prepared, input.extras);
  if (refusal !== null) return { kind: "refused", reason: refusal };
  const authority = ephemeralAuthority(input.plan, input.prepared, input.extras);
  return { kind: "sealed", sealed: Object.freeze({
    attemptId: deriveAttemptId(input.prepared.phaseInstanceId, 0),
    phaseInstanceId: input.prepared.phaseInstanceId,
    logicalPhaseId: input.prepared.phase.logicalPhaseId, disposition: input.prepared.phase.disposition,
    lease: mintAttemptLease(input.now),
    executor: deepCaptureData(input.prepared.phase.executor) as PhaseExecutorV1,
    bounds: deepCaptureData(input.prepared.phase.bounds) as PhaseBoundsV1,
    authority: deepCaptureData(authority) as SealedAuthorityV1,
    authoritySnapshotDigest: authoritySnapshotDigest(authority),
    stateVersionAtSeal: 0,
  }) };
}

/**
 * Re-resolve the authority against the immutable plan after the leg and report
 * the first drift, mirroring the durable attempt's leg-K gate: design section 7.1
 * requires an ephemeral invocation whose authority changed mid-flight to fail
 * rather than return a result the host can no longer vouch for.
 */
export function ephemeralAuthorityDrift(
  plan: NormalizedPreparationPlanV1, sealed: SealedAttemptContextV1, extras: SealAuthorityExtrasV1,
): string | null {
  const prepared = prepareEphemeralPhase(plan, sealed.logicalPhaseId);
  if (prepared.kind !== "ok") return prepared.reason;
  if (prepared.prepared.phaseInstanceId !== sealed.phaseInstanceId) return "phase-drift";
  const refusal = authorityRefusal(prepared.prepared, extras);
  if (refusal !== null) return refusal;
  const current = ephemeralAuthority(plan, prepared.prepared, extras);
  return authoritySnapshotDigest(current) === sealed.authoritySnapshotDigest ? null : "authority-drift";
}
