/**
 * @file src/operation-bundles/run-budget.ts
 * @description Canonical whole-record worst-case staging arithmetic and runtime
 * byte gates. Genesis, bindings, obligations, outcomes, annotations, transition
 * framing, integrity, and reserved control growth all participate in the proof.
 */

import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { RunBudgetErrorBase, budgetCount, budgetLanes } from "../utils/run-budget-arithmetic.js";
import { MAX_MUTATIONS_PER_BUNDLE, MAX_RUN_BYTES, MAX_RUN_TRANSITIONS, MAX_TRANSITION_ENVELOPE_BYTES, RUN_CONTROL_RESERVE_BYTES } from "./constants.js";
import type { OperationTransitionType } from "./run-types.js";

export interface RunBudgetInput {
  mutationCount: number;
  declaredCompensatorCount: number;
  projectionCount: number;
  controlTransitionAllowance: number;
}

export interface RunBudget {
  projectedTransitionCount: number;
  projectedOrdinaryBytes: number;
  projectedTotalBytes: number;
  remainingReserve: number;
}

export type RunWriteBudgetClass = "ordinary" | "control";

const CONTROL_TRANSITION_TYPES = new Set<OperationTransitionType>([
  "recovery-required", "recovery-resumed", "compensation-began",
  "succeeded", "succeeded-with-warnings", "rejected", "superseded",
  "approval-invalidated", "cancelled", "compensated", "failed", "recovered",
  "abandoned",
]);

/** Classify a transition without allowing callers to select the reserved lane. */
export function operationRunWriteBudgetClass(type: OperationTransitionType): RunWriteBudgetClass {
  return CONTROL_TRANSITION_TYPES.has(type) ? "control" : "ordinary";
}

/** Typed pre-staging or runtime refusal with a stable dimension message. */
export class RunBudgetError extends RunBudgetErrorBase {}

const DIGEST = `sha256:${"f".repeat(64)}`;
/** Produce a maximal-width synthetic mutation identity for byte budgeting. */
const MUTATION = (index: number) => `opm_${index.toString(16).padStart(64, "f")}`;
/** Produce a maximal-width synthetic compensation identity for byte budgeting. */
const COMPENSATION = (index: number) => `opc_${index.toString(16).padStart(64, "e")}`;
const CODE = "\\".repeat(128);
const AT = "+010000-01-01T00:00:00.000Z";
const APPLYING_CONTROL_FLOOR = 2;
const EVIDENCE = { digest: DIGEST, byteCount: 262_144, type: CODE, provenance: CODE };

/** Require one exact nonnegative safe-integer count. */
function exactCount(value: number, label: string): number {
  return budgetCount(value, label, RunBudgetError);
}

/** Compute the complete transition count, including the already-durable genesis. */
function transitionCount(input: RunBudgetInput): number {
  const mutations = exactCount(input.mutationCount, "mutation count");
  const compensators = exactCount(input.declaredCompensatorCount, "declared compensator count");
  const projections = exactCount(input.projectionCount, "projection count");
  if (mutations + projections > MAX_MUTATIONS_PER_BUNDLE || compensators > mutations) {
    throw new RunBudgetError("projected run exceeds manifest work bounds");
  }
  const units = mutations + compensators + projections;
  const controls = exactCount(input.controlTransitionAllowance, "control transition allowance");
  const approvalCompanions = Math.max(0, controls - APPLYING_CONTROL_FLOOR);
  const count = 3 + units * 2 + projections + controls
    + Math.min(controls, MAX_MUTATIONS_PER_BUNDLE) + approvalCompanions;
  if (!Number.isSafeInteger(count) || count > MAX_RUN_TRANSITIONS) throw new RunBudgetError("projected run exceeds the 1,100 transition cap");
  return count;
}

/** Populate the maximum accepted mutation, compensation, and projection arrays. */
function worstCaseOutcomes(input: RunBudgetInput) {
  const mutations = Array.from({ length: input.mutationCount }, (_, index) => ({ mutationId: MUTATION(index), status: "skipped-idempotent", transitionSequence: MAX_RUN_TRANSITIONS - 1 }));
  const compensations = Array.from({ length: input.declaredCompensatorCount }, (_, index) => ({ compensationId: COMPENSATION(index), mutationId: MUTATION(index), status: "completed", transitionSequence: MAX_RUN_TRANSITIONS - 1 }));
  const projections = Array.from({ length: input.projectionCount }, (_, index) => ({ mutationId: MUTATION(input.mutationCount + index), criticality: "optional", status: "skipped-idempotent", transitionSequence: MAX_RUN_TRANSITIONS - 1 }));
  return { mutations, compensations, projections };
}

/** Size one exact residual finding for every work identity abandonment can name. */
function worstCaseResiduals(input: RunBudgetInput) {
  const count = input.mutationCount + input.projectionCount;
  return Array.from({ length: count }, (_, index) => ({
    code: CODE, mutationId: MUTATION(index), authoritativeNamespace: CODE, evidence: EVIDENCE,
  }));
}

/** Build maximum top-level growth without counting transition array members. */
function worstCaseRecordBase(input: RunBudgetInput): object {
  const outcomes = worstCaseOutcomes(input);
  const warningCount = input.projectionCount;
  const noticeCount = Math.min(input.controlTransitionAllowance, MAX_MUTATIONS_PER_BUNDLE);
  return {
    schemaVersion: 1, runId: `opr_${"Z".repeat(26)}`, bundleId: `bnd_${"Z".repeat(26)}`,
    manifestDigest: DIGEST, workspaceId: "w".repeat(128), keyEpochId: DIGEST,
    state: "succeeded-with-warnings", stateVersion: MAX_RUN_TRANSITIONS,
    controlTransitionAllowance: input.controlTransitionAllowance, authoritySnapshotDigest: DIGEST,
    obligations: {
      authoritativeMutationIds: outcomes.mutations.map((item) => item.mutationId),
      compensations: outcomes.compensations.map(({ compensationId, mutationId }) => ({ compensationId, mutationId })),
      projections: outcomes.projections.map(({ mutationId, criticality }) => ({ mutationId, criticality })),
    },
    mutationOutcomes: outcomes.mutations, compensationOutcomes: outcomes.compensations,
    projectionOutcomes: outcomes.projections,
    counters: { mutations: { attempted: input.mutationCount, applied: 0, skipped: input.mutationCount, failed: 0 }, compensations: { attempted: input.declaredCompensatorCount, completed: input.declaredCompensatorCount, failed: 0 }, projections: { attempted: input.projectionCount, applied: 0, skipped: warningCount > 0 ? 0 : input.projectionCount, failed: warningCount > 0 ? input.projectionCount : 0 } },
    completionWarnings: Array.from({ length: warningCount }, () => ({
      code: CODE, attempted: Number.MAX_SAFE_INTEGER, completed: Number.MAX_SAFE_INTEGER,
      skipped: Number.MAX_SAFE_INTEGER, failed: Number.MAX_SAFE_INTEGER,
    })),
    notices: Array.from({ length: noticeCount }, () => ({ code: CODE })),
    residualFindings: worstCaseResiduals(input), transitions: [],
    applyOwner: { pid: Number.MAX_SAFE_INTEGER, processStartTime: CODE },
    createdAt: AT, updatedAt: AT, integrity: "f".repeat(64),
  };
}

/** Add exact array separators and the full 2 KiB cap for every transition. */
function recordBytesAtTransitionCap(baseBytes: number, count: number): number {
  const bytes = baseBytes + count * MAX_TRANSITION_ENVELOPE_BYTES + Math.max(0, count - 1);
  if (!Number.isSafeInteger(bytes)) throw new RunBudgetError("projected run byte arithmetic overflow");
  return bytes;
}

/** Return canonical whole-record ordinary bytes and bounded control delta. */
export function projectRunBudget(input: RunBudgetInput): RunBudget {
  const projectedTransitionCount = transitionCount(input);
  const controls = exactCount(input.controlTransitionAllowance, "control transition allowance");
  const baseBytes = canonicalBytes(worstCaseRecordBase(input)).byteLength;
  const { ordinary, total, controlBytes } = budgetLanes(baseBytes,
    { total: projectedTransitionCount, controls }, recordBytesAtTransitionCap);
  if (ordinary > MAX_RUN_BYTES - RUN_CONTROL_RESERVE_BYTES) throw new RunBudgetError("projected ordinary run consumes reserved control headroom");
  if (controlBytes > RUN_CONTROL_RESERVE_BYTES) throw new RunBudgetError("control transition allowance exceeds the 128 KiB control reserve");
  if (total > MAX_RUN_BYTES) throw new RunBudgetError("projected run exceeds the 4 MiB record cap");
  return { projectedTransitionCount, projectedOrdinaryBytes: ordinary, projectedTotalBytes: total, remainingReserve: RUN_CONTROL_RESERVE_BYTES - controlBytes };
}

/** Reject exact serialized bytes outside their ordinary or reserved lane. */
export function assertOperationRunWriteBudget(bytes: number, budgetClass: RunWriteBudgetClass): void {
  exactCount(bytes, "serialized run bytes");
  if (bytes > MAX_RUN_BYTES) throw new RunBudgetError("operation run exceeds the 4 MiB record cap");
  if (budgetClass === "ordinary" && bytes > MAX_RUN_BYTES - RUN_CONTROL_RESERVE_BYTES) {
    throw new RunBudgetError("ordinary run write would consume reserved control headroom");
  }
}
