/**
 * @file src/preparations/attempts/types.ts
 * @description The version-one value objects for lease-fenced three-leg phase
 * attempts (design sections 12.5, 14.3, 15.2 through 15.5, 16.1). It defines the
 * attempt lease, the leg outcome a provider/host executor projects, the sealed
 * authority snapshot the commit revalidates against, the leg-runner shape, and
 * the host-handler boundary WOP consumes. No type here carries an HMAC key, an
 * absolute evidence path, or a live store writer: the sealed intent is the only
 * bridge across the lock-released execution leg (design section 15.3).
 */

import type { AttemptId, PhaseInstanceId } from "../ids.js";
import type {
  PhaseInstanceState, PreparationPrincipalV1, PreparationRunBinding, PreparationRunState,
} from "../run-types.js";
import type { EvidenceRefV1, Sha256Digest } from "../types.js";
import type { PhaseBoundsV1, PhaseExecutorV1 } from "../plan-types.js";
import type { ExternalEffectReceiptV1 } from "../../capability-providers/brokers/receipts.js";

/**
 * The durable run states from which a phase attempt may be started at all.
 *
 * EXPORTED because it is the answer to a question outside this module too: the
 * attempt executor is one of the consumers that POLLS the advisory cancellation
 * file, so "can an attempt still run here?" is also "can a published cancellation
 * still be observed here?". The sweep that has to know which states leave an
 * advisory with no consumer at all derives that from this set rather than from a
 * second copy of the executor's precondition, which is how a state added to one
 * comes to be missing from the other.
 */
export const ATTEMPT_STARTABLE_RUN_STATES: ReadonlySet<PreparationRunState> =
  new Set<PreparationRunState>(["planned", "running"]);

/**
 * Advisory liveness plus stale-result fencing for one attempt (design section
 * 12.5). PID and process start time follow the hardened lock-owner identity; the
 * random nonce fences a late result after cancellation, supersession, or
 * recovery. A lease is NOT a lock and grants no write authority.
 */
export interface AttemptLeaseV1 {
  readonly pid: number;
  readonly processStartTime?: string;
  readonly leaseNonce: string;
  readonly acquiredAt: string;
}

/** The exact settled phase-instance states an attempt leg may resolve to. */
export type AttemptSettledPhaseState = Extract<
  PhaseInstanceState,
  "succeeded" | "succeeded-with-warnings" | "failed" | "cancelled" | "recovery-required"
>;

/** One host-observed external effect an attempt leg produced, receipt and all. */
export interface AttemptEffectObservationV1 {
  readonly receipt: ExternalEffectReceiptV1;
  readonly effectIndex: number;
}

/**
 * One output object copied into TEMPORARY custody while the lock was released and
 * awaiting authoritative publication into the preparation evidence CAS under the
 * lock at commit. `tempPath` lives outside the project/operator/cache; `ref` is
 * the preparation-owned metadata the run will record once its bytes are published.
 */
export interface PendingEvidenceV1 {
  readonly ref: EvidenceRefV1;
  readonly tempPath: string;
}

/**
 * The normalized bounded outcome one provider or host-handler leg projects onto
 * the attempt surface (design sections 16.2, 15.4). Provider prose, counts, and
 * claims never reach here: only the host-derived settled state, the immutable
 * output-evidence references, the host-observed receipts, and bounded counters.
 */
export interface AttemptLegOutcomeV1 {
  readonly phaseState: AttemptSettledPhaseState;
  readonly outputEvidenceDigest?: Sha256Digest;
  /** Output objects held in temporary custody, published under the lock at commit. */
  readonly pendingEvidence: readonly PendingEvidenceV1[];
  /** The temporary custody directory to discard on park or after publication. */
  readonly custodyTempDir?: string;
  readonly effects: readonly AttemptEffectObservationV1[];
  readonly invocationCount: number;
  /** Host-observed total broker requests (incl. read-only), not the effect count. */
  readonly brokerRequestCount: number;
  /**
   * Host-observed usage, or the explicit `"unobserved"` sentinel when the runtime
   * does not measure the dimension. A nonzero sealed ceiling on an unobserved
   * dimension fails closed at admission — never committed as if measured.
   */
  readonly tokenCount: number | "unobserved";
  readonly costMicros: number | "unobserved";
  /** The observed provider pin, if any leg receipt or checkpoint was produced. */
  readonly observedProviderPinDigest?: Sha256Digest;
  /** The observed effective-grant snapshot, if the leg resolved a grant. */
  readonly observedGrantSnapshotDigest?: Sha256Digest;
  /**
   * The backend/sandbox readiness the leg actually ran under. Backend readiness
   * is only observable during execution, so the leg surfaces it and the commit
   * compares it against the sealed expectation (design section 15.3, row 3).
   */
  readonly observedBackendReadinessDigest?: Sha256Digest;
  /** Fixed problem code recorded on a failed/parked leg; never caller free text. */
  readonly problem?: string;
  /**
   * The host's own sentence about the failure ("provider grant store is
   * unavailable"). Host-authored, never provider-supplied bytes: every writer is
   * a host `failed(problem, detail)` site, so it can be persisted without
   * laundering untrusted output into the run record.
   */
  readonly problemDetail?: string;
}

/**
 * The exact authority the sealed intent binds (design section 15.3). Recomputed
 * and compared before commit; any drift discards the late result. Every field is
 * a recomputable digest so a forged value cannot pass revalidation.
 */
export interface SealedAuthorityV1 {
  readonly manifestDigest: Sha256Digest;
  readonly planDigest: Sha256Digest;
  readonly knowledgeAuthorityDigest: Sha256Digest;
  readonly operationsAuthorityDigest: Sha256Digest;
  readonly actionDescriptorDigest: Sha256Digest;
  readonly handlerContractDigest: Sha256Digest;
  readonly recipeDigest: Sha256Digest;
  readonly safetyFloorDigest: Sha256Digest;
  readonly executorDigest: Sha256Digest;
  readonly inputExposureSetDigest: Sha256Digest;
  readonly grantSnapshotDigest?: Sha256Digest;
  readonly providerPinDigest?: Sha256Digest;
  readonly effectPlanDigest?: Sha256Digest;
  readonly brokerPlanDigest?: Sha256Digest;
  readonly backendReadinessDigest?: Sha256Digest;
}

/**
 * The complete sealed attempt intent written under the project lock at leg C and
 * revalidated at leg K. It is a frozen data-only snapshot; lock continuity is
 * never treated as authority continuity (design section 15.3).
 */
export interface SealedAttemptContextV1 {
  readonly attemptId: AttemptId;
  readonly phaseInstanceId: PhaseInstanceId;
  readonly logicalPhaseId: string;
  readonly disposition: "required" | "optional";
  readonly lease: AttemptLeaseV1;
  readonly executor: PhaseExecutorV1;
  /** The immutable sealed phase resource ceilings enforced on the leg and admission. */
  readonly bounds: PhaseBoundsV1;
  readonly authority: SealedAuthorityV1;
  readonly authoritySnapshotDigest: Sha256Digest;
  readonly stateVersionAtSeal: number;
}

/** Orchestration identities the provider adapter binds; never a run path (16.1). */
export interface PreparationProviderContextV1 {
  readonly preparationRunId: string;
  readonly phaseInstanceId: PhaseInstanceId;
  readonly attemptId: AttemptId;
  readonly leaseNonce: string;
  readonly providerPinDigest: Sha256Digest;
  readonly inputExposureSetDigest: Sha256Digest;
}

/** Injected clock returning a strict ISO-8601 instant for durable timestamps. */
export interface AttemptClockV1 { now(): string }

/** The context one leg runner receives once the project lock is released. */
export interface AttemptLegContextV1 {
  readonly attemptId: AttemptId;
  readonly lease: AttemptLeaseV1;
  readonly sealed: SealedAttemptContextV1;
  /**
   * The EXECUTOR-owned cancellation signal (design section 23.2). The executor
   * creates it per attempt and trips it when a valid operator `.cancel` advisory
   * is observed during the lock-released leg; the provider/host-handler leg wires
   * it into its Provider V2 invocation so cooperative cancel and forced backend
   * termination reach the running backend. It is never caller-supplied.
   *
   * TRUE OF THE ATTEMPT EXECUTOR ONLY. The ephemeral read composes this signal
   * with a CALLER-supplied one (`AbortSignal.any` in `ephemeral-execute.ts`), so
   * a signal arriving here from that path is not host-owned. Nothing there feeds
   * a cancellation settlement, so no durable decision rests on it — but do not
   * carry the "host-owned signal" reasoning across. Note also that a holder of
   * any signal can SHADOW its `aborted` getter with an own property, so the flag
   * is never evidence about the host; see `cancel-delivery.ts` for what is.
   */
  readonly cancelSignal?: AbortSignal;
}

/**
 * A provider or host-handler execution leg (design section 15.2 legs F–H). It
 * runs ONLY while the project lock is released and returns a bounded normalized
 * outcome. {@link file://./provider.ts} and {@link file://./host-handler.ts}
 * construct concrete runners; a unit test injects a fake.
 */
export type AttemptLegRunnerV1 = (context: AttemptLegContextV1) => Promise<AttemptLegOutcomeV1>;

// --- Host-handler boundary (WOP supplies concrete handlers, section 15.4) --

/** The exact host-handler an attempt selects; resolved against the registry. */
export interface HostHandlerRefV1 {
  readonly handlerId: string;
  readonly handlerContractVersion: string;
  readonly handlerContractDigest: Sha256Digest;
}

/**
 * The resolved descriptor a registry binds. It declares the exact contract,
 * version, digest, resource bounds, and recovery behavior so the attempt can
 * fail closed when any property drifts from what the phase sealed (15.4).
 */
export interface HostHandlerDescriptorV1 {
  readonly handlerId: string;
  readonly handlerContractVersion: string;
  readonly handlerContractDigest: Sha256Digest;
  readonly effectClass: "pure" | "reads-project" | "uses-broker" | "external-effect";
  readonly deterministic: boolean;
  readonly maximumOutputBytes: number;
  readonly maximumWallTimeMs: number;
  readonly recovery: "restart-safe" | "checkpoint" | "park-on-crash";
}

/** One resolved host-handler and its declared descriptor. */
export interface HostHandlerResolutionV1 {
  readonly handler: PreparationHostHandlerV1;
  readonly descriptor: HostHandlerDescriptorV1;
}

/** The one generic host-handler boundary consumed by WOP (Task 4 public API). */
export interface PreparationHostHandlerRegistryV1 {
  resolve(ref: HostHandlerRefV1): HostHandlerResolutionV1;
}

/** The bounded invocation one host handler receives; never a run/store path. */
export interface HostHandlerInvocationV1 {
  readonly attemptId: AttemptId;
  readonly phaseInstanceId: PhaseInstanceId;
  readonly leaseNonce: string;
  readonly inputExposureSetDigest: Sha256Digest;
  readonly maximumOutputBytes: number;
  readonly maximumWallTimeMs: number;
  readonly hostSignal?: AbortSignal;
}

/**
 * One host-handler output the leg copies into temporary custody by SOURCE PATH,
 * then publishes into the preparation evidence CAS under the lock. A handler
 * produces bytes on disk; it never writes authoritative evidence itself.
 */
export interface HostHandlerOutputV1 {
  readonly sourcePath: string;
  readonly mediaType: string;
  readonly provenanceLabel: string;
  readonly digest: Sha256Digest;
  readonly byteCount: number;
}

/** The closed host-handler result; evidence only, never authored run state. */
export type HostHandlerResultV1 =
  | {
      readonly kind: "completed";
      readonly succeededWithWarnings: boolean;
      readonly outputs: readonly HostHandlerOutputV1[];
      readonly outputEvidenceDigest?: Sha256Digest;
      readonly receipts?: readonly ExternalEffectReceiptV1[];
    }
  | { readonly kind: "failed"; readonly problem: string; readonly detail: string }
  | { readonly kind: "cancelled" };

/** One registered host handler. WOP supplies concrete handlers; tests fake it. */
export interface PreparationHostHandlerV1 {
  execute(request: HostHandlerInvocationV1): Promise<HostHandlerResultV1>;
}

/**
 * The authority digests recomputed from AUTHORITATIVE CURRENT state (never from
 * caller-supplied constants). The host-owned resolver produces this at seal AND
 * re-produces it at leg K; a difference is real drift and parks the late result.
 */
export interface SealAuthorityExtrasV1 {
  readonly inputExposureSetDigest: Sha256Digest;
  readonly grantSnapshotDigest?: Sha256Digest;
  readonly providerPinDigest?: Sha256Digest;
  readonly effectPlanDigest?: Sha256Digest;
  readonly brokerPlanDigest?: Sha256Digest;
  readonly backendReadinessDigest?: Sha256Digest;
}

/** The exact phase identity a resolver recomputes current authority for. */
export interface AttemptAuthorityContextV1 {
  readonly executor: PhaseExecutorV1;
  readonly phaseInstanceId: PhaseInstanceId;
  readonly logicalPhaseId: string;
}

/** A resolver's outcome: recomputed extras, or a fail-closed unavailable reason. */
export type AttemptAuthorityResolutionV1 =
  | { readonly status: "ok"; readonly extras: SealAuthorityExtrasV1 }
  | { readonly status: "unavailable"; readonly reason: string };

/**
 * The host-owned authority resolver injected into every attempt. It recomputes
 * the sealed authority extras from authoritative current state (installed
 * provider pin, resolved grant, plan-bound effect/broker plans, exposure). The
 * orchestrator invokes it under the lock at intent to SEAL and again under the
 * lock at leg K to RE-RESOLVE; comparing the two closes the drift gate that a
 * caller-supplied constant would make tautological. WOP/Task 10 install the
 * concrete resolver; a unit test injects a fake whose output can change.
 */
export interface AttemptAuthorityResolverV1 {
  resolve(context: AttemptAuthorityContextV1): Promise<AttemptAuthorityResolutionV1>;
}

/**
 * The complete request to execute one lease-fenced three-leg phase attempt. The
 * executor, gate, bounds, and disposition are NOT accepted here: they are read
 * from the immutable sealed plan phase named by `logicalPhaseId`, so a caller
 * cannot substitute a weaker executor or drop a gate (design section 15.3).
 */
export interface AttemptExecutionRequestV1 {
  readonly root: string;
  readonly binding: PreparationRunBinding;
  readonly phaseInstanceId: PhaseInstanceId;
  readonly logicalPhaseId: string;
  readonly attemptIndex: number;
  readonly authorityResolver: AttemptAuthorityResolverV1;
  readonly leg: AttemptLegRunnerV1;
  readonly principal: PreparationPrincipalV1;
  readonly clock: AttemptClockV1;
}

/** The closed terminal outcome of executing one phase attempt. */
export type AttemptOutcomeV1 =
  | { readonly status: "committed"; readonly attemptId: AttemptId; readonly phaseState: AttemptSettledPhaseState }
  | { readonly status: "parked"; readonly reason: string }
  | { readonly status: "blocked"; readonly reason: string }
  | { readonly status: "refused-busy" };
