/**
 * @file src/preparations/attempts/provider.ts
 * @description The provider execution leg (design section 16.1). It RECONSTRUCTS
 * a fresh request handed to invoke by classifying EVERY field: DATA fields
 * (identity, grant request, input specs with byte copies, input, operation
 * context, declared outputs, custody validators, launch source) are deep-captured
 * into an immutable tree; the HOST-OWNED launch root is host-derived (a fresh
 * temp dir, overriding any caller value); host-resolved secrets are never passed
 * through; the BROKER SURFACE is rebuilt into a fresh frozen container carrying
 * exactly the adapter keys observed at classification, so a key added to the
 * caller's object during the await before invoke can never widen it; and the
 * remaining branded/behavioral collaborators (authorized paths, package artifact,
 * host signal) are bound by reference for the SINGLE invoke call only — nothing
 * in the commit/revalidate path reads them. The
 * authority is validated against the sealed attempt, including a SYMMETRIC
 * effect-plan check: a request carrying an effect plan the seal does not declare
 * is rejected. Only the reconstructed object reaches `invokeCapabilityProvider`.
 */

import { createHash } from "node:crypto";
import {
  invokeCapabilityProvider,
  type ProviderInvocationHostV1, type ProviderInvocationRequestV1,
  type ProviderInvocationResultV1,
} from "../../capability-providers/runtime/invoke.js";
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import { parseSha256Digest } from "../../capability-providers/ids.js";
import { captureOwnDataRecord, deepCaptureData } from "../../utils/runtime-capture.js";
import { admitProviderLeg } from "./admit-result.js";
import { createCustodyDir, discardCustody } from "./custody.js";
import type { PhaseExecutorV1 } from "../plan-types.js";
import type { Sha256Digest } from "../types.js";
import type {
  AttemptLegContextV1, AttemptLegOutcomeV1, AttemptLegRunnerV1,
  PreparationProviderContextV1, SealedAuthorityV1,
} from "./types.js";

const EXPOSURE_DOMAIN = "llmwiki-preparation-provider-inputspec-exposure-v1";
const BROKER_KINDS = ["https", "model", "repository", "command", "scheduler", "email", "remote-effect"];
/** The sealed cost ceiling is micro-USD; the provider's modelCostUsd is USD. */
const MICROS_PER_USD = 1_000_000;
type Record0 = Readonly<Record<string, unknown>>;

/** Which broker adapters a request carries: any at all, and specifically `model`. */
export interface BrokerCapability { readonly any: boolean; readonly model: boolean }

/**
 * Rebuild the broker surface as a FRESH FROZEN container holding exactly the own
 * data keys the accessor-rejecting capture observes HERE. Each adapter VALUE
 * stays a by-reference behavioral collaborator — the broker dispatcher captures
 * and drift-checks the adapter graph itself on every call — but the CONTAINER is
 * the host's, so a key added to the caller's object after classification (during
 * the await before invoke) never reaches the invocation. Keys outside
 * {@link BROKER_KINDS} are carried through unchanged so the dispatcher's own
 * unknown-key refusal still fires instead of being silently dropped here.
 */
function captureBrokerSurface(brokers: unknown): Record0 {
  return Object.freeze({ ...captureOwnDataRecord(brokers) });
}

/** Classify the broker adapters present in an already-captured surface. */
function brokerCapabilityOf(surface: Record0): BrokerCapability {
  const present = BROKER_KINDS.filter((kind) => surface[kind] !== undefined);
  return { any: present.length > 0, model: present.includes("model") };
}

/** Classify the broker adapters present on a request (accessor-rejecting). */
function brokerCapability(brokers: unknown): BrokerCapability {
  return brokerCapabilityOf(captureOwnDataRecord(brokers) as Record0);
}

/**
 * Classify one request's broker adapters through the SAME accessor-rejecting
 * capture this leg uses, so a caller that wants a second, sealed-authority-aware
 * broker check (the ephemeral read's broker-plan symmetry) shares this
 * classification instead of hand-rolling a weaker one.
 */
export function requestBrokerCapability(request: ProviderInvocationRequestV1): BrokerCapability {
  return brokerCapability(captureOwnDataRecord(request).brokers);
}

/** The single provider invocation seam; the real entrypoint is the default. */
export type ProviderInvokeFn = (
  request: ProviderInvocationRequestV1, host: ProviderInvocationHostV1,
) => Promise<ProviderInvocationResultV1>;

/**
 * A pre-built provider invocation and the orchestration identity it runs under.
 * It deliberately carries NO project root or evidence destination: this leg only
 * ever copies output into temporary custody, and authoritative publication is the
 * executor's under-lock commit (design section 15.2 leg L).
 */
export interface ProviderLegInputV1 {
  readonly request: ProviderInvocationRequestV1;
  readonly host: ProviderInvocationHostV1;
  readonly preparationRunId: string;
}

type ProviderExecutor = Extract<PhaseExecutorV1, { kind: "provider-capability" }>;

/** Require a non-empty string field, translating a hostile value into refusal. */
function requireText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("provider input spec field is invalid");
  return value;
}

/** Content-only exposure digest over the ACTUAL input specs invoke materializes. */
export function providerInputSpecsContentExposureDigest(specs: readonly Record0[]): Sha256Digest {
  const inputs = specs.map((spec) => {
    if (!(spec.bytes instanceof Uint8Array)) throw new Error("provider input spec bytes are invalid");
    return {
      inputId: requireText(spec.inputId), kind: requireText(spec.kind),
      provenanceLabel: requireText(spec.provenanceLabel), mediaType: requireText(spec.mediaType),
      digest: createHash("sha256").update(spec.bytes).digest("hex"), byteCount: spec.bytes.byteLength,
    };
  });
  return parseSha256Digest(canonicalDigest({ domain: EXPOSURE_DOMAIN, inputs }));
}

interface CapturedRequest {
  top: Record0;
  sourceTreeReal: unknown;
  artifact: unknown;
  expectedIdentity: Record0;
  authorityRequest: Record0;
  inputSpecs: readonly Record0[];
  input: unknown;
  operationContext: Record0;
  declaredOutputs: readonly unknown[];
  custodyValidators: readonly unknown[];
  brokerSurface: Record0;
  brokers: BrokerCapability;
}

/** Capture the request top level and DEEP-capture every data-bearing field. */
function captureRequest(request: ProviderInvocationRequestV1): CapturedRequest {
  const top = captureOwnDataRecord(request);
  const launch = captureOwnDataRecord(top.launch);
  const brokerSurface = captureBrokerSurface(top.brokers);
  return {
    top, sourceTreeReal: deepCaptureData(launch.sourceTreeReal), artifact: deepCaptureData(launch.artifact),
    expectedIdentity: deepCaptureData(top.expectedIdentity) as Record0,
    authorityRequest: deepCaptureData(top.authorityRequest) as Record0,
    inputSpecs: deepCaptureData(top.inputSpecs) as readonly Record0[],
    input: deepCaptureData(top.input),
    operationContext: deepCaptureData(top.operationContext) as Record0,
    declaredOutputs: deepCaptureData(top.declaredOutputs) as readonly unknown[],
    custodyValidators: deepCaptureData(top.custodyValidators) as readonly unknown[],
    brokerSurface, brokers: brokerCapabilityOf(brokerSurface),
  };
}

/**
 * PRE-INVOCATION structural enforcement of the zero ceilings (RC-B): a phase with
 * a zero broker-request bound must carry NO broker adapters, and a phase with a
 * zero token or cost bound must carry NO model adapter — a capability that could
 * consume a dimension under a zero ceiling is a contradictory seal and fails
 * closed BEFORE the provider runs, not after the call already happened.
 */
function assertBrokerCapabilityWithinBounds(brokers: BrokerCapability, bounds: { maximumBrokerRequestsPerAttempt: number; maximumTokensPerAttempt: number; maximumCostMicrosPerAttempt: number }): void {
  if (bounds.maximumBrokerRequestsPerAttempt === 0 && brokers.any) {
    throw new Error("provider request carries broker adapters under a zero broker-request bound");
  }
  if ((bounds.maximumTokensPerAttempt === 0 || bounds.maximumCostMicrosPerAttempt === 0) && brokers.model) {
    throw new Error("provider request carries a model adapter under a zero token or cost bound");
  }
}

/** Fail closed unless the captured fields carry exactly the sealed authority. */
function assertCapturedBindsSealed(captured: CapturedRequest, executor: ProviderExecutor, authority: SealedAuthorityV1): void {
  const id = captured.expectedIdentity;
  if (id.providerPinDigest !== executor.providerPinDigest) throw new Error("provider request pin does not match the sealed executor");
  if (id.capabilityId !== executor.capabilityId || captured.authorityRequest.capabilityId !== executor.capabilityId) {
    throw new Error("provider request capability does not match the sealed executor");
  }
  if (id.capabilitySchemaDigest !== executor.capabilityContractDigest) throw new Error("provider request capability schema does not match the sealed executor");
  if (providerInputSpecsContentExposureDigest(captured.inputSpecs) !== authority.inputExposureSetDigest) {
    throw new Error("provider request exposure does not match the sealed attempt");
  }
  assertEffectPlanBindsSealed(captured.authorityRequest.effectPlan, authority.effectPlanDigest);
}

/** True when an effect plan claims at least one effect. */
function planClaimsEffects(requestEffectPlan: unknown): boolean {
  if (requestEffectPlan === undefined || requestEffectPlan === null) return false;
  const entries = (requestEffectPlan as { entries?: unknown }).entries;
  // A malformed plan is treated as claiming something: the grant resolver is the
  // authority on plan SHAPE, and a value this cannot read must not slip through
  // a check whose whole job is to notice unsealed claims.
  return !Array.isArray(entries) || entries.length > 0;
}

/**
 * Symmetric effect-plan check: reject effects the seal does not authorize.
 *
 * A SEAL THAT DECLARES NO PLAN AUTHORIZES NO EFFECTS — which is not the same as
 * forbidding the request to carry a plan OBJECT. The effective-grant request
 * type always carries one, so requiring its absence made an effect-free
 * provider phase unreachable: the phase would fail closed no matter what the
 * host sent. What must hold is that the plan CLAIMS nothing, and a zero-entry
 * plan claims nothing regardless of the ceilings it states, because ceilings
 * bound effects that do not exist.
 */
function assertEffectPlanBindsSealed(requestEffectPlan: unknown, sealedDigest: Sha256Digest | undefined): void {
  if (sealedDigest === undefined) {
    if (planClaimsEffects(requestEffectPlan)) {
      throw new Error("provider request carries an effect plan the sealed authority does not declare");
    }
    return;
  }
  if (parseSha256Digest(canonicalDigest(requestEffectPlan)) !== sealedDigest) {
    throw new Error("provider request effect plan does not match the sealed attempt");
  }
}

/** The sealed ceilings intersected into the provider authority envelope. */
interface SealedInvocationBounds {
  maximumBrokerRequestsPerAttempt: number;
  maximumTokensPerAttempt: number;
  maximumCostMicrosPerAttempt: number;
}

/** A caller number, or +Infinity when absent (an omitted limit is unbounded). */
function callerOrInfinity(value: unknown): number {
  return typeof value === "number" ? value : Number.POSITIVE_INFINITY;
}

/**
 * ALWAYS construct/tighten one provider resource-bound's broker-request ceiling
 * to the sealed maximum, exactly like {@link intersectScopeMaxima}. A missing or
 * non-object bounds block is NOT passed through untouched: the sealed ceiling is
 * stamped onto a fresh block, which the grant parser then rejects for its missing
 * dimensions — so the refusal is this seam's own explicit construction rather
 * than an implicit reliance on a distant parser seeing an absent field.
 */
function intersectBrokerRequests(bounds: unknown, brokerMax: number): Record0 {
  const base = bounds !== null && typeof bounds === "object" ? bounds as Record0 : {};
  return Object.freeze({ ...base, brokerRequests: Math.min(callerOrInfinity(base.brokerRequests), brokerMax) });
}

/**
 * ALWAYS construct/tighten a grant scope's model-token and model-cost broker
 * maxima to the sealed per-attempt ceilings, even when the caller omitted the
 * `brokerMaximums` block — an omitted block means the host ceiling (unbounded
 * from the sealed view), so the sealed value applies. Cost is converted from the
 * sealed micro-USD ceiling to the provider's USD unit via {@link MICROS_PER_USD}.
 */
function intersectScopeMaxima(scope: unknown, tokenMax: number, costMicrosMax: number): Record0 {
  const base = scope !== null && typeof scope === "object" ? scope as Record0 : {};
  const maxima = base.brokerMaximums !== null && typeof base.brokerMaximums === "object" ? base.brokerMaximums as Record0 : {};
  return Object.freeze({
    ...base,
    brokerMaximums: Object.freeze({
      ...maxima,
      modelTokens: Math.min(callerOrInfinity(maxima.modelTokens), tokenMax),
      modelCostUsd: Math.min(callerOrInfinity(maxima.modelCostUsd), costMicrosMax / MICROS_PER_USD),
    }),
  });
}

/**
 * Intersect the SEALED phase ceilings into the reconstructed provider authority
 * envelope BEFORE invocation, so the Provider V2 runtime itself refuses anything
 * above the sealed ceiling during execution — the extra call never happens. The
 * post-hoc usage check remains as defense-in-depth (RC-B).
 */
function intersectAuthorityBounds(authorityRequest: Record0, sealed: SealedInvocationBounds): Record0 {
  const brokerMax = sealed.maximumBrokerRequestsPerAttempt;
  return Object.freeze({
    ...authorityRequest,
    resourceBounds: intersectBrokerRequests(authorityRequest.resourceBounds, brokerMax),
    surfaceCap: intersectBrokerRequests(authorityRequest.surfaceCap, brokerMax),
    operationsPackRequest: intersectScopeMaxima(authorityRequest.operationsPackRequest, sealed.maximumTokensPerAttempt, sealed.maximumCostMicrosPerAttempt),
  });
}

/**
 * Compose the EXECUTOR-owned cancellation signal (design section 23.2) with any
 * caller-supplied signal so the executor's cancel always reaches the backend and
 * a caller signal still fires. The executor signal is authoritative; when it is
 * absent (a unit test), the caller signal, if any, is used unchanged.
 */
function composeHostSignal(executorSignal: AbortSignal | undefined, callerSignal: unknown): AbortSignal | undefined {
  const caller = callerSignal instanceof AbortSignal ? callerSignal : undefined;
  if (executorSignal === undefined) return caller;
  return caller === undefined ? executorSignal : AbortSignal.any([executorSignal, caller]);
}

/** Reconstruct the closed request: captured data, host-derived launch root, by-ref plumbing. */
function reconstructRequest(captured: CapturedRequest, launchParentDir: string, sealed: SealedInvocationBounds, hostSignal: AbortSignal | undefined): ProviderInvocationRequestV1 {
  const t = captured.top;
  return Object.freeze({
    paths: t.paths, invocationId: t.invocationId, nonce: t.nonce,
    authorityRequest: intersectAuthorityBounds(captured.authorityRequest, sealed), expectedIdentity: captured.expectedIdentity,
    launch: Object.freeze({ sourceTreeReal: captured.sourceTreeReal, artifact: captured.artifact, launchParentDir }),
    inputSpecs: captured.inputSpecs, input: captured.input, operationContext: captured.operationContext,
    declaredOutputs: captured.declaredOutputs, custodyValidators: captured.custodyValidators,
    brokers: captured.brokerSurface, ...(hostSignal === undefined ? {} : { hostSignal }),
  }) as unknown as ProviderInvocationRequestV1;
}

/** Derive the orchestration context from the sealed attempt; never a run path. */
function providerContext(input: ProviderLegInputV1, legContext: AttemptLegContextV1, pin: Sha256Digest): PreparationProviderContextV1 {
  return {
    preparationRunId: input.preparationRunId, phaseInstanceId: legContext.sealed.phaseInstanceId,
    attemptId: legContext.attemptId, leaseNonce: legContext.lease.leaseNonce,
    providerPinDigest: pin, inputExposureSetDigest: legContext.sealed.authority.inputExposureSetDigest,
  };
}

/**
 * Build the provider leg runner. It runs ONLY while the project lock is released,
 * hands invoke a reconstructed request rooted at a host-derived launch directory,
 * and copies the admitted output into temporary custody; the host launch root is
 * discarded after admission regardless of outcome.
 */
export function providerLegRunner(
  input: ProviderLegInputV1, invoke: ProviderInvokeFn = invokeCapabilityProvider,
): AttemptLegRunnerV1 {
  return async (legContext): Promise<AttemptLegOutcomeV1> => {
    const executor = legContext.sealed.executor;
    if (executor.kind !== "provider-capability") throw new Error("provider leg used for a non-provider-capability phase");
    const captured = captureRequest(input.request);
    assertCapturedBindsSealed(captured, executor, legContext.sealed.authority);
    assertBrokerCapabilityWithinBounds(captured.brokers, legContext.sealed.bounds);
    const context = providerContext(input, legContext, executor.providerPinDigest);
    const hostSignal = composeHostSignal(legContext.cancelSignal, captured.top.hostSignal);
    const launchParentDir = await createCustodyDir();
    try {
      const result = await invoke(reconstructRequest(captured, launchParentDir, legContext.sealed.bounds, hostSignal), input.host);
      // Token/cost usage is applicable only when a model adapter is present; without
      // one the capability cannot consume those dimensions, so they are a proven 0.
      return await admitProviderLeg(result, context, legContext.sealed.bounds.maximumOutputEvidenceBytes, captured.brokers.model);
    } finally {
      await discardCustody(launchParentDir);
    }
  };
}
