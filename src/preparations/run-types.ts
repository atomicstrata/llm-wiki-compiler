/**
 * @file src/preparations/run-types.ts
 * @description Closed version-one DTOs for the mutable preparation-run authority
 * (design sections 12.3, 12.5, 13.2, and 14). The HMAC-protected run file holds
 * only bounded identifiers, fixed-shape summaries, counters, and out-of-line
 * evidence references; provider text, prompts, executable bytes, or free-form
 * caller payloads never enter it. Every derived identity carried here is
 * re-derivable so a loader can reject a forged `sha256:`-shaped value.
 */

import type {
  AttemptId, BrokerRequestId, GateProofId, HandoffId, PhaseInstanceId,
  PreparationId, PreparationRunId,
} from "./ids.js";
import type { EvidenceRefV1, Sha256Digest } from "./types.js";

/** Every durable preparation-run state (design section 14.1). */
export const PREPARATION_RUN_STATES = Object.freeze([
  "planned", "awaiting-gate", "running", "paused", "cancelling",
  "recovery-required", "handoff-ready", "handoff-started", "handed-off",
  "succeeded", "succeeded-with-warnings", "failed", "cancelled",
  "cancelled-with-effects", "superseded", "abandoned",
] as const);

export type PreparationRunState = (typeof PREPARATION_RUN_STATES)[number];

/** Every phase-instance state (design section 14.2). */
export const PHASE_INSTANCE_STATES = Object.freeze([
  "pending", "ready", "awaiting-gate", "running", "checkpointed", "succeeded",
  "succeeded-with-warnings", "skipped-optional", "failed", "cancelled",
  "recovery-required", "superseded",
] as const);

export type PhaseInstanceState = (typeof PHASE_INSTANCE_STATES)[number];

/** Closed transition vocabulary carried by the hash-chained run log. */
export const PREPARATION_TRANSITION_TYPES = Object.freeze([
  "run-planned", "gate-blocked", "gate-decided", "phase-started",
  "phase-progressed", "phase-settled", "paused", "resumed",
  "recovery-required", "recovery-resumed", "handoff-ready", "handoff-started",
  "handed-off", "succeeded", "succeeded-with-warnings", "cancelling",
  "cancelled", "cancelled-with-effects", "superseded", "abandoned", "failed",
  "headroom-exhausted", "notice-recorded", "warning-recorded",
] as const);

export type PreparationTransitionType = (typeof PREPARATION_TRANSITION_TYPES)[number];

/** Closed preparation-run problem codes recorded on a control transition. */
export const PREPARATION_RUN_PROBLEM_CODES = Object.freeze([
  "preparation-run-headroom-exhausted", "preparation-manifest-unavailable",
  "preparation-evidence-unavailable", "preparation-effect-outcome-unknown",
  "preparation-parent-unavailable", "preparation-integrity-obligation",
  // A park a CANCELLATION caused, kept distinct from the generic integrity
  // obligation above. Every other park reason — revalidation drift, a bounds
  // violation, a publication failure — records the generic code, so without this
  // one the durable record cannot say WHY a run is `recovery-required`, and a
  // settlement that must not touch an unrelated integrity obligation has no way
  // to tell the two apart. Additive: an older record simply never carries it.
  "preparation-cancellation-effect-unproven",
  // A park a required leg's FAULT caused. It exists for the same reason as the
  // cancellation code above: without it the durable record cannot say why the
  // run is `recovery-required`, and a leg fault is the one park an operator can
  // often FIX (install the missing tool) before deciding what to do with the
  // run, so telling it apart from an integrity obligation is what makes the
  // record actionable rather than merely accurate.
  "preparation-leg-fault",
] as const);

export type PreparationRunProblemCode = (typeof PREPARATION_RUN_PROBLEM_CODES)[number];

/** The actor principal recorded on every transition. */
export interface PreparationPrincipalV1 {
  id: string;
  surface: string;
}

/**
 * Advisory executor liveness and stale-result fencing (design section 12.5).
 *
 * DESIGN GAP, RECORDED RATHER THAN BUILT: `pid` and `processStartTime` identify a
 * process only WITHIN ONE PID NAMESPACE. A container and its host number
 * processes independently, so a record written inside a container and read from
 * the host (or the reverse) is answered about a different process or about none —
 * a live executor's fence can be cleared, and the signal probe reports ESRCH
 * exactly as it would for a genuine corpse. There is no field here that could
 * tell the two apart.
 *
 * Closing it means a HOST IDENTITY on this record — a namespace or boot
 * identifier the reader can compare against its own (`/proc/self/ns/pid`'s inode
 * on Linux, the machine boot id, or a host-supplied opaque token) plus a
 * fail-closed rule for a record whose host does not match the reader's: never
 * "dead", because liveness there is unobservable. Deliberately NOT built in this
 * slice: it is a durable schema field with a migration and a cross-platform
 * derivation of its own, and no shipped surface runs an executor across a
 * namespace boundary yet.
 */
export interface PreparationExecutionOwnerV1 {
  pid: number;
  processStartTime?: string;
  leaseNonce: string;
  attemptId: AttemptId;
  acquiredAt: string;
}

/** Fixed-shape current state and bounded counters for one phase instance. */
export interface PhaseSummaryV1 {
  phaseInstanceId: PhaseInstanceId;
  logicalPhaseId: string;
  state: PhaseInstanceState;
  disposition: "required" | "optional";
  attemptCount: number;
  currentAttemptId?: AttemptId;
  outputEvidenceDigest?: Sha256Digest;
  checkpointDigest?: Sha256Digest;
  invocationCount: number;
  brokerRequestCount: number;
  effectCount: number;
  /** The failed leg's fixed problem code, durable so `show` can answer WHY. */
  problem?: string;
  /**
   * The host's sentence about the failure. Host-authored and host-bounded; it MAY quote
   * a provider's own reported reason, but only as one neutralised, printable, bounded
   * fragment the host labels untrusted — never raw provider bytes.
   */
  problemDetail?: string;
  /**
   * Host-observed model tokens and host-priced cost for the attempt this summary
   * records. ABSENT is the durable form of the leg outcome's `"unobserved"`
   * sentinel — the runtime could not meter the dimension — and is NEVER written
   * as 0, because a preview reading unmeasured spend as free would understate
   * what a retry has already cost. A measured 0 is written as 0 and means the
   * dimension was observed and genuinely nothing was spent. A record written
   * before these fields existed carries no measurement at all, so it reads
   * unobserved, which is the honest answer for it.
   */
  tokenCount?: number;
  costMicros?: number;
}

/**
 * One recorded gate decision proof (design section 17). The proof persists the
 * FULL authority binding the host authored — not just the plan digest — so a
 * later effect authorization can revalidate every bound dimension (input, effect,
 * authority) against current state and reject an approval that survived drift.
 */
export interface GateProofSummaryV1 {
  gateProofId: GateProofId;
  gateId: string;
  decision: "approved" | "rejected" | "revised";
  decisionIndex: number;
  /**
   * The operator's own reason for the decision, when they gave one.
   *
   * DURABLE BECAUSE DESIGN 17.3 SAYS SO — "a gate rejection durably records the
   * rejected digest AND reason code". It is also bound into the gate fact's
   * digest, so a summary that dropped it made that digest permanently
   * unreconstructible from the record. A bounded component, never free prose:
   * it is a code an operator or a review surface switches on.
   */
  reasonCode?: string;
  planDigest: Sha256Digest;
  phaseDigest: Sha256Digest;
  inputDigest: Sha256Digest;
  effectDigest?: Sha256Digest;
  authorityDigest: Sha256Digest;
  actor: PreparationPrincipalV1;
  at: string;
}

/** One deterministic broker request identity and host-observed state. */
export interface BrokerRequestSummaryV1 {
  brokerRequestId: BrokerRequestId;
  attemptId: AttemptId;
  requestIndex: number;
  state: "started" | "settled" | "unavailable";
}

/**
 * One Provider V2 effect receipt reference and its honest outcome. The durable
 * START persists `claimDigest`, a canonical digest binding EVERY authority
 * dimension of the effect claim (provider pin, grant snapshot, invocation,
 * broker, contract version, effect class, target, effect-plan entry, idempotency
 * key, rollback semantics). At commit the receipt is bound against this stored
 * digest, so a receipt whose context differs on any dimension fails closed. The
 * durable start ALSO persists `brokerRequestId`, the exact broker request this
 * effect is bound to; the commit settles that authenticated request and rejects a
 * caller-supplied context naming a different effect's request.
 */
export interface EffectSummaryV1 {
  attemptId: AttemptId;
  effectIndex: number;
  outcome:
    | "planned" | "started" | "applied" | "already-applied"
    | "refused" | "unavailable" | "failed" | "outcome-unknown";
  /** Host-derived effect identity persisted at the durable start (authenticated). */
  effectId?: string;
  claimDigest?: Sha256Digest;
  /** The broker request this effect is bound to, persisted at the durable start. */
  brokerRequestId?: BrokerRequestId;
  receiptDigest?: Sha256Digest;
}

/** Optional incompleteness that forces `succeeded-with-warnings`. */
export interface RunCompletionWarningV1 {
  code: string;
  attempted: number;
  completed: number;
  skipped: number;
  failed: number;
}

/** Fixed-code informational notice with no caller free text. */
export interface RunNoticeV1 { code: string }

/** Host-authored completeness authority (design section 19). */
export interface CompletenessRecordV1 {
  requiredDeficit: number;
  optionalDeficit: number;
  classDigest?: Sha256Digest;
}

/** Bounded permanent observation used only by residual-state retirement. */
export interface ResidualFindingV1 {
  code: string;
  phaseInstanceId?: PhaseInstanceId;
  evidence?: EvidenceRefV1;
}

/** The verified self-contained Milestone A bundle binding (design section 22). */
export interface HandoffBindingV1 {
  handoffId: HandoffId;
  bundleId: string;
  bundleManifestDigest: Sha256Digest;
  finalTransitionHash: Sha256Digest;
}

/**
 * The reserved-identity recovery authority durably recorded by the
 * `handoff-started` transition BEFORE any Milestone A bundle exists (design
 * section 22.3 step 6). It carries the exact core-minted bundle and operation-run
 * identities, the deterministic bundle-manifest digest, the pre-handoff chain tip
 * the handoff id is derived from, and the origin/evidence-copy digests. On crash
 * this is the sole authority that lets recovery RESUME the exact same bundle
 * creation with the same identities rather than mint a duplicate.
 *
 * The bundle-manifest digest is invariant to the genesis-run authority (staging
 * digests the manifest WITHOUT its `run`), so this record ALSO pins
 * `genesisAuthorityDigest`: a canonical digest of the exact operation-run genesis
 * authority (control-transition allowance, declared compensator indexes, actor)
 * the reserved run will be created with. A resume whose recompiled bundle carries
 * a different control budget or compensation topology fails closed against it
 * rather than landing a divergent genesis run under the reserved identity.
 */
export interface HandoffStartBindingV1 {
  handoffId: HandoffId;
  reservedBundleId: string;
  reservedOperationRunId: string;
  bundleManifestDigest: Sha256Digest;
  genesisAuthorityDigest: Sha256Digest;
  preHandoffTransitionHash: Sha256Digest;
  originEvidenceDigest: Sha256Digest;
  evidenceCopyDigest: Sha256Digest;
}

/** Fixed-shape transition payloads selected by the transition type. */
export type PreparationTransitionPayload =
  | { kind: "none" }
  | { kind: "problem"; code: PreparationRunProblemCode }
  | { kind: "phase"; phaseInstanceId: PhaseInstanceId; phaseState: PhaseInstanceState }
  | { kind: "gate"; gateProofId: GateProofId; decision: "approved" | "rejected" | "revised" }
  | { kind: "warning"; code: string; attempted: number; completed: number; skipped: number; failed: number }
  | { kind: "notice"; code: string }
  | { kind: "supersede"; supersededByPreparationId: PreparationId }
  | ({ kind: "handoff-started" } & HandoffStartBindingV1)
  | { kind: "handoff"; handoffId: HandoffId; bundleManifestDigest: Sha256Digest }
  | { kind: "abandonment"; confirmation: "confirm-residual-state"; findingCount: number };

/** One hash-chained transition envelope (design section 12.3). */
export interface PreparationRunTransitionV1 {
  sequence: number;
  previousHash: Sha256Digest | null;
  contentHash: Sha256Digest;
  actor: PreparationPrincipalV1;
  stateBefore: PreparationRunState;
  stateAfter: PreparationRunState;
  type: PreparationTransitionType;
  at: string;
  payload: PreparationTransitionPayload;
}

/** Complete HMAC input; `integrity` is deliberately absent. */
export interface PreparationRunContentV1 {
  schemaVersion: 1;
  runId: PreparationRunId;
  preparationId: PreparationId;
  manifestDigest: Sha256Digest;
  workspaceId: string;
  keyEpochId: Sha256Digest;
  state: PreparationRunState;
  stateVersion: number;
  controlTransitionAllowance: number;
  executionOwner?: PreparationExecutionOwnerV1;
  phaseSummaries: readonly PhaseSummaryV1[];
  gateProofs: readonly GateProofSummaryV1[];
  brokerRequestSummaries: readonly BrokerRequestSummaryV1[];
  effectSummaries: readonly EffectSummaryV1[];
  evidenceRefs: readonly EvidenceRefV1[];
  completeness: CompletenessRecordV1;
  completionWarnings: readonly RunCompletionWarningV1[];
  notices: readonly RunNoticeV1[];
  residualFindings: readonly ResidualFindingV1[];
  handoff?: HandoffBindingV1;
  supersededByPreparationId?: PreparationId;
  transitions: readonly PreparationRunTransitionV1[];
  createdAt: string;
  updatedAt: string;
}

/** Persisted run authority with whole-record HMAC-SHA256 (design section 12.1). */
export interface PreparationRunV1 extends PreparationRunContentV1 { integrity: string }

/** Exact external identities that a run leaf must bind (design section 13). */
export interface PreparationRunBinding {
  runId: PreparationRunId;
  preparationId: PreparationId;
  manifestDigest: Sha256Digest;
  workspaceId: string;
  keyEpochId: Sha256Digest;
}

/** Inputs for the single version-one genesis constructor. */
export interface InitialPreparationRunInput {
  runId: PreparationRunId;
  preparationId: PreparationId;
  manifestDigest: Sha256Digest;
  workspaceId: string;
  keyEpochId: Sha256Digest;
  actor: PreparationPrincipalV1;
  at: string;
  controlTransitionAllowance: number;
}

/** Inputs for one pure hash-chained transition append. */
export interface AppendPreparationTransitionInput {
  type: PreparationTransitionType;
  stateAfter: PreparationRunState;
  payload: PreparationTransitionPayload;
  actor: PreparationPrincipalV1;
  at: string;
  /** Verified handoff binding bound only by a `handoff` payload. */
  handoff?: HandoffBindingV1;
  /** Verified residual findings bound only by an `abandonment` payload. */
  residualFindings?: readonly ResidualFindingV1[];
}

/** Exact authenticated predecessor expected by an under-lock append. */
export interface PreparationRunPredecessor {
  stateVersion: number;
  chainTip: Sha256Digest;
}
