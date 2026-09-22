/**
 * @file src/operation-bundles/run-types.ts
 * @description Closed version-one DTOs for mutable operation-run authority.
 * Records contain only bounded identifiers, counters, fixed-shape transition
 * payloads, and out-of-line evidence references; executable or free-form
 * payload data never enters the HMAC-protected run file.
 */

import type { BundleId, CompensationId, MutationId, OperationRunId } from "./ids.js";
import type { OperationPrincipal } from "./principal.js";
import type { OperationProblemCode } from "./problems.js";
import type { OperationBundleManifest, OperationDigest } from "./types.js";

/** Every durable state in V2 section 13. */
export const OPERATION_RUN_STATES = Object.freeze([
  "awaiting-approval", "approved", "applying", "recovery-required",
  "compensating", "succeeded", "succeeded-with-warnings", "rejected",
  "superseded", "approval-invalidated", "cancelled", "compensated",
  "failed", "recovered", "abandoned",
] as const);

export type OperationRunState = (typeof OPERATION_RUN_STATES)[number];

/** Closed event vocabulary carried by the transition chain. */
export const OPERATION_TRANSITION_TYPES = Object.freeze([
  "run-staged", "approved", "apply-started", "mutation-started",
  "mutation-applied", "mutation-skipped-idempotent", "mutation-failed",
  "projection-started", "projection-applied", "projection-skipped-idempotent",
  "projection-failed", "recovery-required", "recovery-resumed",
  "compensation-began", "compensation-started", "compensation-completed",
  "compensation-failed", "succeeded", "succeeded-with-warnings", "rejected",
  "superseded", "approval-invalidated", "cancelled", "compensated", "failed",
  "recovered", "abandoned", "notice-recorded", "warning-recorded",
] as const);

export type OperationTransitionType = (typeof OPERATION_TRANSITION_TYPES)[number];
export type MutationOutcomeStatus = "started" | "applied" | "skipped-idempotent" | "failed";
export type CompensationOutcomeStatus = "started" | "completed" | "failed";
export type ProjectionOutcomeStatus = MutationOutcomeStatus;
export type ProjectionCriticality = "required" | "optional";

/** Immutable reference to bounded evidence stored outside the run record. */
export interface RunEvidenceRef {
  digest: OperationDigest;
  byteCount: number;
  type: string;
  provenance: string;
}

/** Fixed reference retained when raw evidence exceeds the blob-store cap. */
export interface EvidenceOverLimitReference {
  kind: "evidence-over-limit";
  digest: OperationDigest;
  byteCount: number;
  type: string;
  provenance: string;
  excerpt: string;
}

/** Closed evidence vocabulary accepted by authenticated transition payloads. */
export type OperationEvidenceReference = RunEvidenceRef | EvidenceOverLimitReference;

/** Fixed-shape transition payloads selected by the transition type. */
export type OperationTransitionPayload =
  | { kind: "none" }
  | { kind: "problem"; code: OperationProblemCode }
  | { kind: "authority"; authoritySnapshotDigest: OperationDigest }
  | { kind: "execution"; authoritySnapshotDigest: OperationDigest; applyOwner: OperationApplyOwner }
  | { kind: "mutation"; mutationId: MutationId; evidence?: OperationEvidenceReference; detail?: string }
  | { kind: "projection"; mutationId: MutationId; criticality: ProjectionCriticality; evidence?: OperationEvidenceReference }
  | { kind: "compensation"; compensationId: CompensationId; mutationId: MutationId; evidence?: OperationEvidenceReference }
  | { kind: "notice"; code: string }
  | { kind: "warning"; code: string; attempted: number; completed: number; skipped: number; failed: number }
  | { kind: "recovery"; bundleId: BundleId; runId: OperationRunId; manifestDigest: OperationDigest; terminalState: RecoveryTerminalState; stateVersion: number; chainTip: OperationDigest }
  | { kind: "abandonment"; confirmation: "confirm-residual-state"; findingCount: number; findingsDigest: OperationDigest };

/** Recovery-run terminal states that are allowed to settle an original run. */
export type RecoveryTerminalState = "succeeded" | "succeeded-with-warnings" | "compensated";

/** One hash-chained transition envelope. */
export interface OperationRunTransition {
  sequence: number;
  previousHash: OperationDigest | null;
  contentHash: OperationDigest;
  actor: OperationPrincipal;
  stateBefore: OperationRunState;
  stateAfter: OperationRunState;
  type: OperationTransitionType;
  at: string;
  payload: OperationTransitionPayload;
}

/** Exact manifest-derived work identities needed to reject foreign outcomes. */
export interface OperationRunObligations {
  authoritativeMutationIds: readonly MutationId[];
  compensations: readonly { compensationId: CompensationId; mutationId: MutationId }[];
  projections: readonly { mutationId: MutationId; criticality: ProjectionCriticality }[];
}

export interface MutationOutcome {
  mutationId: MutationId;
  status: MutationOutcomeStatus;
  transitionSequence: number;
  /**
   * What actually satisfied the postcondition when it was not this mutation's
   * own write — e.g. the pre-existing record id a same-content relation deduped
   * to — so a skip's claim boundary survives into the durable, public outcome.
   */
  detail?: string;
}

export interface CompensationOutcome {
  compensationId: CompensationId;
  mutationId: MutationId;
  status: CompensationOutcomeStatus;
  transitionSequence: number;
}

export interface ProjectionOutcome {
  mutationId: MutationId;
  criticality: ProjectionCriticality;
  status: ProjectionOutcomeStatus;
  transitionSequence: number;
}

export interface MutationCounters {
  attempted: number;
  applied: number;
  skipped: number;
  failed: number;
}

export interface CompensationCounters {
  attempted: number;
  completed: number;
  failed: number;
}

export interface ProjectionCounters extends MutationCounters {}

/** Exact counters duplicated for cheap status rendering and checked on load. */
export interface OperationRunCounters {
  mutations: MutationCounters;
  compensations: CompensationCounters;
  projections: ProjectionCounters;
}

/** Optional incompleteness that forces succeeded-with-warnings. */
export interface RunCompletionWarning {
  code: string;
  attempted: number;
  completed: number;
  skipped: number;
  failed: number;
}

/** Informational fixed-code notice with no caller text. */
export interface RunNotice { code: string }

/** Bounded permanent observation used only by residual-state retirement. */
export interface ResidualFinding {
  code: string;
  mutationId?: MutationId;
  authoritativeNamespace?: string;
  evidence?: RunEvidenceRef;
}

/** Process identity while a run can have live work in flight. */
export interface OperationApplyOwner {
  pid: number;
  processStartTime: string;
}

/** Complete HMAC input; `integrity` is deliberately absent. */
export interface OperationRunContent {
  schemaVersion: 1;
  runId: OperationRunId;
  bundleId: BundleId;
  manifestDigest: OperationDigest;
  workspaceId: string;
  keyEpochId: OperationDigest;
  state: OperationRunState;
  stateVersion: number;
  controlTransitionAllowance: number;
  authoritySnapshotDigest: OperationDigest | null;
  obligations: OperationRunObligations;
  mutationOutcomes: readonly MutationOutcome[];
  compensationOutcomes: readonly CompensationOutcome[];
  projectionOutcomes: readonly ProjectionOutcome[];
  counters: OperationRunCounters;
  completionWarnings: readonly RunCompletionWarning[];
  notices: readonly RunNotice[];
  residualFindings: readonly ResidualFinding[];
  transitions: readonly OperationRunTransition[];
  applyOwner?: OperationApplyOwner;
  createdAt: string;
  updatedAt: string;
}

/** Persisted run authority with whole-record HMAC-SHA256. */
export interface OperationRun extends OperationRunContent { integrity: string }

/** Exact external identities that a run leaf must bind. */
export interface OperationRunBinding {
  runId: OperationRunId;
  bundleId: BundleId;
  manifestDigest: OperationDigest;
  workspaceId: string;
  keyEpochId: OperationDigest;
}

/** Inputs for the single version-one genesis constructor. */
export interface InitialOperationRunInput {
  manifest: OperationBundleManifest;
  manifestDigest: OperationDigest;
  keyEpochId: OperationDigest;
  actor: OperationPrincipal;
  at: string;
  declaredCompensatorMutationIds: readonly MutationId[];
  controlTransitionAllowance: number;
}

/** Inputs for one pure hash-chained transition append. */
export interface AppendOperationTransitionInput {
  type: OperationTransitionType;
  stateAfter: OperationRunState;
  payload: OperationTransitionPayload;
  actor: OperationPrincipal;
  at: string;
  /** Detailed abandonment observations projected outside the 2 KiB envelope. */
  residualFindings?: readonly ResidualFinding[];
}

/** Exact authenticated predecessor expected by an under-lock append. */
export interface OperationRunPredecessor {
  stateVersion: number;
  chainTip: OperationDigest;
}
