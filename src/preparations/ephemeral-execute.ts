/**
 * @file src/preparations/ephemeral-execute.ts
 * @description Executable ephemeral read (design sections 7.1, 28.3; plan Task 3;
 * PRD "Query Without Mutation"). An ephemeral read is a NO-DURABLE-WRITE attempt:
 * it seals the phase from the immutable plan, runs the SAME hardened
 * provider/host-handler leg a durable attempt runs — constructed field by field
 * from captured data, bounded by the sealed ceilings, rooted in host-derived
 * temporary custody — and then projects a bounded, host-verified result. It takes
 * no project root, acquires no lock, appends no transition, writes no manifest or
 * receipt, and publishes nothing to the preparation evidence CAS; the temporary
 * custody is discarded in `finally` on every path. A gate, external effect,
 * checkpoint, durable retention, bounded repeat, or handoff disqualifies the plan
 * before any custody or launch, and every authority — capability surface, pin,
 * contract, exposure, effect plan, broker surface, bounds — is bound to the sealed
 * plan, never to the caller.
 *
 * TRUST MODEL: the plan this read seals against is CALLER-SUPPLIED and
 * UNAUTHENTICATED — no manifest is staged, so there are no stored bytes to
 * authenticate it against (see {@link file://./ephemeral-seal.ts}). "Sealed"
 * means frozen-at-capture and bound for the whole read, NOT manifest-grade
 * provenance. The host anchors are the authority resolver's pin, exposure set,
 * broker plan, and absence of an effect plan; the caller chooses which read-only
 * work runs, and never the authority it runs under.
 */

import { createHash } from "node:crypto";
import {
  invokeCapabilityProvider,
  type ProviderInvocationHostV1, type ProviderInvocationRequestV1,
} from "../capability-providers/runtime/invoke.js";
import { captureOwnDataRecord, RuntimeCaptureError } from "../utils/runtime-capture.js";
import { readCappedNoFollowBuffer } from "../utils/confined-read.js";
import { mintPreparationRunId } from "./ids.js";
import { providerLegRunner, requestBrokerCapability, type ProviderInvokeFn } from "./attempts/provider.js";
import { hostHandlerLegRunner } from "./attempts/host-handler.js";
import { discardCustody } from "./attempts/custody.js";
import { boundsViolation, snapshotSealAuthorityExtras } from "./attempts/execute.js";
import {
  captureEphemeralPlan, ephemeralAuthorityDrift, prepareEphemeralPhase, sealEphemeralPhase,
  type PreparedEphemeralPhaseV1,
} from "./ephemeral-seal.js";
import type { NormalizedPreparationPlanV1 } from "./plan-types.js";
import type { Sha256Digest } from "./types.js";
import type {
  AttemptAuthorityResolverV1, AttemptClockV1, AttemptLegContextV1, AttemptLegOutcomeV1,
  AttemptLegRunnerV1, AttemptSettledPhaseState, PendingEvidenceV1, PreparationHostHandlerRegistryV1,
  SealAuthorityExtrasV1, SealedAttemptContextV1,
} from "./attempts/types.js";

const SHA256_PREFIX = "sha256:";
/** Node's maximum timer delay; a larger sealed bound is clamped, never wrapped. */
const MAXIMUM_TIMER_MS = 2_147_483_647;

/**
 * Read-only provider work: the caller's invocation is bound, never forwarded.
 * There is deliberately NO `invoke` field — the provider runtime is not
 * selectable from request DATA. A request carrying one is refused outright.
 */
export interface EphemeralProviderWorkV1 {
  readonly kind: "provider-capability";
  readonly request: ProviderInvocationRequestV1;
  readonly host: ProviderInvocationHostV1;
}

/** Read-only host-handler work; the handler REF comes from the sealed executor. */
export interface EphemeralHostHandlerWorkV1 {
  readonly kind: "host-handler";
  readonly registry: PreparationHostHandlerRegistryV1;
}

/** The closed set of work an ephemeral read may drive. */
export type EphemeralWorkV1 = EphemeralProviderWorkV1 | EphemeralHostHandlerWorkV1;

/** One bounded output the read returns; its bytes are verified, never published. */
export interface EphemeralOutputV1 {
  readonly mediaType: string;
  readonly provenanceLabel: string;
  readonly digest: Sha256Digest;
  readonly byteCount: number;
  readonly bytes: Uint8Array;
  /** Provider/handler bytes are untrusted content, marked on the value itself. */
  readonly untrusted: true;
}

/** The closed terminal outcome of one ephemeral read; a refusal is data, not prose. */
export type EphemeralReadResultV1 =
  | {
      readonly status: "completed";
      readonly phaseState: AttemptSettledPhaseState;
      readonly outputs: readonly EphemeralOutputV1[];
      readonly invocationCount: number;
      readonly brokerRequestCount: number;
      readonly tokenCount: number | "unobserved";
      readonly costMicros: number | "unobserved";
      readonly problem?: string;
    }
  | { readonly status: "refused"; readonly reason: string };

/**
 * One ephemeral read. The executor, bounds, disposition, and every authority
 * digest are read from `plan` by `logicalPhaseId` — they are deliberately NOT
 * accepted here, so a caller cannot substitute a weaker executor or a wider bound.
 */
export interface EphemeralReadRequestV1 {
  readonly plan: NormalizedPreparationPlanV1;
  readonly logicalPhaseId: string;
  readonly authorityResolver: AttemptAuthorityResolverV1;
  readonly work: EphemeralWorkV1;
  readonly clock: AttemptClockV1;
  readonly cancelSignal?: AbortSignal;
}

/** The work snapshot: data captured, collaborator callables bound exactly once. */
type CapturedWorkV1 =
  | { readonly kind: "provider-capability"; readonly request: ProviderInvocationRequestV1; readonly host: ProviderInvocationHostV1; readonly invoke: ProviderInvokeFn }
  | { readonly kind: "host-handler"; readonly registry: PreparationHostHandlerRegistryV1 };

/** The frozen request snapshot every later step reads from. */
interface CapturedEphemeralRequestV1 {
  readonly plan: NormalizedPreparationPlanV1;
  readonly logicalPhaseId: string;
  readonly resolve: AttemptAuthorityResolverV1["resolve"];
  readonly now: () => string;
  readonly work: CapturedWorkV1;
  readonly cancelSignal?: AbortSignal;
}

/** Build the fixed refusal outcome. */
function refused(reason: string): EphemeralReadResultV1 {
  return { status: "refused", reason };
}

/**
 * Capture the work selection, binding the collaborator callables once. The
 * provider runtime comes from `invoke` — the host's own argument — and a request
 * that nonetheless carries an `invoke` FIELD is refused rather than ignored, so
 * no caller-supplied data can select what executes.
 */
function captureWork(value: unknown, invoke: ProviderInvokeFn): CapturedWorkV1 {
  const work = captureOwnDataRecord(value);
  if (work.kind === "provider-capability") {
    if (work.invoke !== undefined) throw new RuntimeCaptureError();
    return Object.freeze({
      kind: "provider-capability" as const, request: work.request as ProviderInvocationRequestV1,
      host: work.host as ProviderInvocationHostV1, invoke,
    });
  }
  if (work.kind === "host-handler") {
    const registry = work.registry as PreparationHostHandlerRegistryV1;
    return Object.freeze({ kind: "host-handler" as const, registry: { resolve: registry.resolve.bind(registry) } });
  }
  throw new RuntimeCaptureError();
}

/**
 * Capture the complete request BEFORE any await: the plan becomes an immutable
 * data-only tree, the resolver and clock callables are bound once, and accessors
 * or proxies are rejected outright — so nothing the read validates can differ
 * from what it executes.
 */
function captureEphemeralRequest(input: EphemeralReadRequestV1, invoke: ProviderInvokeFn): CapturedEphemeralRequestV1 {
  const top = captureOwnDataRecord(input);
  const plan = captureEphemeralPlan(top.plan as NormalizedPreparationPlanV1);
  if (plan === null || typeof top.logicalPhaseId !== "string") throw new RuntimeCaptureError();
  const resolver = top.authorityResolver as AttemptAuthorityResolverV1;
  const clock = top.clock as AttemptClockV1;
  return Object.freeze({
    plan, logicalPhaseId: top.logicalPhaseId,
    resolve: resolver.resolve.bind(resolver), now: clock.now.bind(clock),
    work: captureWork(top.work, invoke),
    ...(top.cancelSignal === undefined ? {} : { cancelSignal: top.cancelSignal as AbortSignal }),
  });
}

type ExtrasResolution =
  | { kind: "ok"; extras: SealAuthorityExtrasV1 }
  | { kind: "refused"; reason: string };

/**
 * Resolve the authority for the prepared phase from authoritative current state,
 * failing closed on any resolver fault. The executor and phase identity handed to
 * the resolver come from the immutable plan, never from the caller.
 */
async function resolveExtras(
  request: CapturedEphemeralRequestV1, prepared: PreparedEphemeralPhaseV1,
): Promise<ExtrasResolution> {
  try {
    const resolution = await request.resolve({
      executor: prepared.phase.executor, logicalPhaseId: prepared.phase.logicalPhaseId,
      phaseInstanceId: prepared.phaseInstanceId,
    });
    if (resolution.status !== "ok") return { kind: "refused", reason: `authority-${resolution.reason}` };
    return { kind: "ok", extras: snapshotSealAuthorityExtras(resolution.extras) };
  } catch {
    return { kind: "refused", reason: "authority-resolver-fault" };
  }
}

type LegSelection =
  | { kind: "ok"; run: AttemptLegRunnerV1 }
  | { kind: "refused"; reason: string };

/**
 * Wrap the provider leg with the ephemeral broker-surface check. The check reads
 * the request through the SAME accessor-rejecting capture the leg uses and runs
 * in the same synchronous stretch as the leg's own capture (no await separates
 * them), so a swapped value cannot slip between the two reads. A phase whose
 * sealed authority declares no broker plan may carry no broker adapter at all —
 * symmetric presence and absence, not merely a zero-ceiling check.
 */
function brokerSurfaceGuard(
  run: AttemptLegRunnerV1, request: ProviderInvocationRequestV1, sealed: SealedAttemptContextV1,
): AttemptLegRunnerV1 {
  return (context) => {
    if (sealed.authority.brokerPlanDigest === undefined && requestBrokerCapability(request).any) {
      throw new Error("ephemeral invocation carries broker adapters the sealed plan does not declare");
    }
    return run(context);
  };
}

/** Build the sealed leg: the executor kind selects it and supplies every bound. */
function legRunnerFor(request: CapturedEphemeralRequestV1, sealed: SealedAttemptContextV1): LegSelection {
  const executor = sealed.executor;
  const work = request.work;
  if (executor.kind === "provider-capability" && work.kind === "provider-capability") {
    const run = providerLegRunner({ request: work.request, host: work.host, preparationRunId: mintPreparationRunId() }, work.invoke);
    return { kind: "ok", run: brokerSurfaceGuard(run, work.request, sealed) };
  }
  if (executor.kind === "host-handler" && work.kind === "host-handler") {
    return { kind: "ok", run: hostHandlerLegRunner({
      ref: {
        handlerId: executor.handlerId, handlerContractVersion: executor.handlerContractVersion,
        handlerContractDigest: executor.handlerContractDigest,
      },
      registry: work.registry, maximumOutputBytes: sealed.bounds.maximumOutputEvidenceBytes,
      maximumWallTimeMs: sealed.bounds.maximumTimeMsPerInstance,
    }) };
  }
  return { kind: "refused", reason: "work-kind-not-sealed-executor" };
}

/** Map a thrown leg to its fixed refusal; caller text never reaches the result. */
function legRefusal(error: unknown): string {
  return error instanceof RuntimeCaptureError ? "invocation-not-capturable" : "invocation-rejected";
}

type BoundedLeg =
  | { kind: "ok"; outcome: AttemptLegOutcomeV1 }
  | { kind: "refused"; reason: string };

/** An unref'd delay that never holds the process open past the read. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });
}

/**
 * How long a time-bounded read waits, AFTER delivering the cancel, for the
 * abandoned leg to settle so its custody is discarded BEFORE the read returns.
 * It is a drain, not a second execution budget: a leg that honors the cancel
 * settles at once, and one that ignores it must not re-extend the sealed bound.
 */
const CANCELLED_LEG_DRAIN_MS = 1_000;

/**
 * Run the leg under the executor-owned cancellation signal and a HARD wall-clock
 * bound taken from the sealed phase. When the bound expires the signal is tripped
 * (delivering the cancel to the backend) and the read is refused; the abandoned
 * leg's temporary custody is discarded as soon as it settles — awaited within a
 * bounded drain so a cancel-honoring leg leaves NO residue at return, with the
 * same discard still attached for a leg that outlives the drain.
 */
async function runBoundedLeg(
  run: AttemptLegRunnerV1, context: AttemptLegContextV1, boundMs: number, controller: AbortController,
): Promise<BoundedLeg> {
  // The guarded runner refuses SYNCHRONOUSLY, so start it inside a promise chain
  // rather than relying on `run(context)` returning a rejected promise.
  const leg = Promise.resolve()
    .then(() => run(context))
    .then((outcome) => ({ kind: "ok" as const, outcome }), (error: unknown) => ({ kind: "refused" as const, reason: legRefusal(error) }));
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<{ kind: "deadline" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "deadline" }), Math.min(boundMs, MAXIMUM_TIMER_MS));
    timer.unref?.();
  });
  const settled = await Promise.race([leg, deadline]);
  clearTimeout(timer);
  if (settled.kind !== "deadline") return settled;
  controller.abort();
  const discarded = leg
    .then((late) => (late.kind === "ok" ? discardCustody(late.outcome.custodyTempDir) : undefined))
    .catch(() => {});
  await Promise.race([discarded, delay(CANCELLED_LEG_DRAIN_MS)]);
  return { kind: "refused", reason: "time-bound-exceeded" };
}

/**
 * Compose the caller's cancel into the EXECUTOR-owned signal the leg receives
 * (design section 23.2): the executor's own controller is authoritative — it is
 * what the wall-clock bound trips — and a caller signal only adds a second way to
 * cancel. Composition uses `AbortSignal.any`, so no listener outlives the read.
 */
function legContext(
  sealed: SealedAttemptContextV1, controller: AbortController, caller: AbortSignal | undefined,
): AttemptLegContextV1 {
  const cancelSignal = caller === undefined ? controller.signal : AbortSignal.any([controller.signal, caller]);
  return { attemptId: sealed.attemptId, lease: sealed.lease, sealed, cancelSignal };
}

/** Re-verify one custodied object and project it as a bounded read output. */
async function projectOutput(item: PendingEvidenceV1, cap: number): Promise<EphemeralOutputV1 | null> {
  const read = await readCappedNoFollowBuffer(item.tempPath, cap);
  if (read.kind !== "ok" || read.body.byteLength !== item.ref.byteCount) return null;
  if (createHash("sha256").update(read.body).digest("hex") !== item.ref.digest.slice(SHA256_PREFIX.length)) return null;
  return {
    mediaType: item.ref.mediaType, provenanceLabel: item.ref.provenanceLabel, digest: item.ref.digest,
    byteCount: item.ref.byteCount, bytes: Uint8Array.from(read.body), untrusted: true,
  };
}

/**
 * Project every custodied output into the bounded response, re-verifying each
 * object's digest and holding the AGGREGATE within the sealed ceiling. Null on
 * any unreadable, oversize, or disagreeing object so the read fails closed.
 */
async function projectOutputs(pending: readonly PendingEvidenceV1[], cap: number): Promise<readonly EphemeralOutputV1[] | null> {
  const outputs: EphemeralOutputV1[] = [];
  let total = 0;
  for (const item of pending) {
    const output = await projectOutput(item, cap);
    if (output === null) return null;
    total += output.byteCount;
    if (total > cap) return null;
    outputs.push(output);
  }
  return Object.freeze(outputs);
}

/** Project the bounded completed result from a validated leg outcome. */
function completedResult(outcome: AttemptLegOutcomeV1, outputs: readonly EphemeralOutputV1[]): EphemeralReadResultV1 {
  return {
    status: "completed", phaseState: outcome.phaseState, outputs,
    invocationCount: outcome.invocationCount, brokerRequestCount: outcome.brokerRequestCount,
    tokenCount: outcome.tokenCount, costMicros: outcome.costMicros,
    ...(outcome.problem === undefined ? {} : { problem: outcome.problem }),
  };
}

/**
 * Validate the leg outcome against the sealed authority and ceilings, then
 * project the bounded result. An observed external effect refuses outright: a
 * read that mutated something is not an ephemeral read, whatever it returned.
 */
async function projectResult(
  request: CapturedEphemeralRequestV1, prepared: PreparedEphemeralPhaseV1,
  sealed: SealedAttemptContextV1, outcome: AttemptLegOutcomeV1,
): Promise<EphemeralReadResultV1> {
  if (outcome.effects.length > 0) return refused("external-effect-observed");
  const extras = await resolveExtras(request, prepared);
  if (extras.kind !== "ok") return refused(extras.reason);
  const drift = ephemeralAuthorityDrift(request.plan, sealed, extras.extras);
  if (drift !== null) return refused(drift);
  const violation = boundsViolation(sealed, outcome);
  if (violation !== null) return refused(violation);
  const outputs = await projectOutputs(outcome.pendingEvidence, sealed.bounds.maximumOutputEvidenceBytes);
  return outputs === null ? refused("output-projection-failed") : completedResult(outcome, outputs);
}

/** Run the sealed leg in temporary custody, discarding it on every path. */
async function runSealedLeg(
  request: CapturedEphemeralRequestV1, prepared: PreparedEphemeralPhaseV1,
  sealed: SealedAttemptContextV1, run: AttemptLegRunnerV1,
): Promise<EphemeralReadResultV1> {
  if (sealed.bounds.maximumTimeMsPerInstance <= 0) return refused("time-bound-exceeded");
  const controller = new AbortController();
  const context = legContext(sealed, controller, request.cancelSignal);
  const bounded = await runBoundedLeg(run, context, sealed.bounds.maximumTimeMsPerInstance, controller);
  if (bounded.kind !== "ok") return refused(bounded.reason);
  try {
    return await projectResult(request, prepared, sealed, bounded.outcome);
  } finally {
    await discardCustody(bounded.outcome.custodyTempDir);
  }
}

/** Seal the read: prepare the phase from the plan, then bind the resolved authority. */
async function sealRequest(
  request: CapturedEphemeralRequestV1,
): Promise<{ kind: "ok"; prepared: PreparedEphemeralPhaseV1; sealed: SealedAttemptContextV1 } | { kind: "refused"; reason: string }> {
  const prepared = prepareEphemeralPhase(request.plan, request.logicalPhaseId);
  if (prepared.kind !== "ok") return { kind: "refused", reason: prepared.reason };
  const extras = await resolveExtras(request, prepared.prepared);
  if (extras.kind !== "ok") return { kind: "refused", reason: extras.reason };
  const seal = sealEphemeralPhase({
    plan: request.plan, prepared: prepared.prepared, extras: extras.extras, now: request.now(),
  });
  return seal.kind === "sealed"
    ? { kind: "ok", prepared: prepared.prepared, sealed: seal.sealed }
    : { kind: "refused", reason: seal.reason };
}

/**
 * Execute one ephemeral read and return its bounded result. Nothing durable is
 * created on ANY path: no run, manifest, transition, receipt, cache entry, or
 * published evidence object — only host-owned temporary custody that is always
 * discarded before returning.
 */
export function runEphemeralRead(input: EphemeralReadRequestV1): Promise<EphemeralReadResultV1> {
  return executeEphemeralRead(input, invokeCapabilityProvider);
}

/**
 * @internal TEST-ONLY seam. The provider runtime is a PARAMETER of this
 * host-side function, never a field of the request, so substituting it requires
 * calling a different function — no caller-supplied request object can reach it.
 * Production callers use {@link runEphemeralRead}.
 */
export function runEphemeralReadWithInvoke(
  input: EphemeralReadRequestV1, invoke: ProviderInvokeFn,
): Promise<EphemeralReadResultV1> {
  return executeEphemeralRead(input, invoke);
}

/** Capture, seal, select the leg, and run it under the sealed bounds. */
async function executeEphemeralRead(
  input: EphemeralReadRequestV1, invoke: ProviderInvokeFn,
): Promise<EphemeralReadResultV1> {
  let request: CapturedEphemeralRequestV1;
  try {
    request = captureEphemeralRequest(input, invoke);
  } catch {
    return refused("request-not-capturable");
  }
  const seal = await sealRequest(request);
  if (seal.kind !== "ok") return refused(seal.reason);
  let selection: LegSelection;
  try {
    selection = legRunnerFor(request, seal.sealed);
  } catch (error) {
    return refused(legRefusal(error));
  }
  return selection.kind === "ok"
    ? runSealedLeg(request, seal.prepared, seal.sealed, selection.run)
    : refused(selection.reason);
}
