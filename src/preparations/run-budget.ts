/**
 * @file src/preparations/run-budget.ts
 * @description Canonical whole-record worst-case staging arithmetic and runtime
 * byte gates for the preparation run (design section 12.4). The declared plan
 * bounds size the worst-case summaries, evidence references, handoff, and
 * annotations; every transition is charged the full 2 KiB envelope; the reserved
 * 256 KiB control headroom is proven to hold every fixed-shape terminal,
 * cancel, park, supersede, abandonment, and handoff-settlement move. A plan that
 * cannot retire within the non-reserved budget fails closed without writing.
 */

import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { RunBudgetErrorBase, budgetCount, budgetLanes } from "../utils/run-budget-arithmetic.js";
import {
  MAX_EVIDENCE_REFS_PER_RUN, MAX_PHASE_INSTANCES_PER_RUN,
  MAX_PREPARATION_RUN_BYTES, MAX_PREPARATION_TRANSITION_ENVELOPE_BYTES,
  MAX_TRANSITIONS_PER_RUN, PREPARATION_RUN_CONTROL_RESERVE_BYTES,
} from "./constants.js";
import type { PreparationTransitionType } from "./run-types.js";

/** The declared worst-case dimensions that size a preparation run record. */
export interface RunBudgetInput {
  maximumPhaseInstances: number;
  maximumEvidenceRefs: number;
  maximumBrokerRequests: number;
  maximumEffects: number;
  maximumTransitions: number;
  controlTransitionAllowance: number;
}

/** The proven whole-record worst case and remaining control reserve. */
export interface RunBudget {
  projectedTransitionCount: number;
  projectedOrdinaryBytes: number;
  projectedTotalBytes: number;
  remainingReserve: number;
}

export type RunWriteBudgetClass = "ordinary" | "control";

/**
 * The transitions that draw on the reserved control headroom rather than the
 * ordinary lane.
 *
 * `resumed` IS HERE BECAUSE `paused` IS. The reserve exists so a run can always be
 * moved to a state an operator can manage, and `paused` was admitted to it while
 * its inverse was not — so a run paused with its record inside the reserve zone
 * could be held but not released, and the only remaining exits were the
 * destructive and terminal ones the pause/resume guarantee exists to avoid. A
 * reversible pair must share a lane; one half in the reserve and the other
 * outside it is a strand built out of two correct-looking halves.
 *
 * It grants the resumed run no extra ordinary headroom: its next ordinary write
 * meets the same ceiling and the same `headroom-exhausted` route, which is itself
 * a control transition. The reserve is spent returning the run to a workable
 * state, which is what the reserve is for.
 */
const CONTROL_TRANSITION_TYPES = new Set<PreparationTransitionType>([
  "recovery-required", "headroom-exhausted", "handoff-ready", "handoff-started",
  "handed-off", "succeeded", "succeeded-with-warnings", "cancelling", "cancelled",
  "cancelled-with-effects", "superseded", "abandoned", "failed", "paused", "resumed",
]);

/** Classify a transition without allowing callers to select the reserved lane. */
export function preparationRunWriteBudgetClass(type: PreparationTransitionType): RunWriteBudgetClass {
  return CONTROL_TRANSITION_TYPES.has(type) ? "control" : "ordinary";
}

/** Typed pre-staging or runtime refusal with a stable dimension message. */
export class RunBudgetError extends RunBudgetErrorBase {}

const DIGEST = `sha256:${"f".repeat(64)}`;
const PHASE = `phi_${"f".repeat(64)}`;
const ATTEMPT = `pat_${"f".repeat(64)}`;
const BROKER = `brq_${"f".repeat(64)}`;
const GATE = `gpf_${"f".repeat(64)}`;
const HANDOFF = `hof_${"f".repeat(64)}`;
const CODE = "\\".repeat(128);
const COMPONENT = "w".repeat(128);
const AT = "+010000-01-01T00:00:00.000Z";

/** Require one exact nonnegative safe-integer count. */
function exactCount(value: number, label: string): number {
  return budgetCount(value, label, RunBudgetError);
}

/** Compute the complete worst-case transition count, including control moves. */
function transitionCount(input: RunBudgetInput): number {
  const ordinary = exactCount(input.maximumTransitions, "maximum transitions");
  const controls = exactCount(input.controlTransitionAllowance, "control transition allowance");
  if (controls <= 0) throw new RunBudgetError("preparation run requires positive control transition headroom");
  const count = ordinary + controls;
  if (!Number.isSafeInteger(count) || count > MAX_TRANSITIONS_PER_RUN) {
    throw new RunBudgetError("projected run exceeds the 3,200 transition cap");
  }
  return count;
}

/** Build one maximal-width evidence reference for record byte budgeting. */
function worstEvidence() {
  return {
    kind: CODE, mediaType: CODE, provenanceLabel: CODE, digest: DIGEST, byteCount: Number.MAX_SAFE_INTEGER,
    sensitivity: "restricted", retention: "until-handoff",
    producer: { kind: "broker", brokerId: COMPONENT, requestId: CODE }, untrusted: true,
  };
}

/**
 * Build one maximal-width phase summary for record byte budgeting.
 *
 * It must carry EVERY field `parsePhaseSummary` accepts, each at its widest
 * value: this literal is what proves a staged plan's worst-case record fits the
 * record cap, and a field the parser accepts but this omits is byte growth the
 * admission proof never charged for — a plan admitted at the boundary would then
 * strand mid-run when the write budget rejects the record it was told would fit.
 * Exported so a structural test pins it against the parser's own field list
 * rather than trusting the two to be updated together.
 */
export function worstPhase() {
  return {
    phaseInstanceId: PHASE, logicalPhaseId: COMPONENT, state: "succeeded-with-warnings",
    disposition: "required", attemptCount: Number.MAX_SAFE_INTEGER, currentAttemptId: ATTEMPT,
    outputEvidenceDigest: DIGEST, checkpointDigest: DIGEST, invocationCount: Number.MAX_SAFE_INTEGER,
    brokerRequestCount: Number.MAX_SAFE_INTEGER, effectCount: Number.MAX_SAFE_INTEGER,
    tokenCount: Number.MAX_SAFE_INTEGER, costMicros: Number.MAX_SAFE_INTEGER,
    // Widest values the PARSER admits (128 / 516 bytes), not the writer's cap:
    // the budget must cover any record the reader would accept.
    problem: "p".repeat(128), problemDetail: "d".repeat(516),
  };
}

/** Build the maximal top-level record growth without the transition array. */
function worstCaseRecordBase(input: RunBudgetInput): object {
  const phases = exactCount(input.maximumPhaseInstances, "maximum phase instances");
  const wide = (length: number, build: () => unknown) => Array.from({ length }, build);
  return {
    schemaVersion: 1, runId: `prr_${"f".repeat(32)}`, preparationId: `prp_${"f".repeat(32)}`,
    manifestDigest: DIGEST, workspaceId: COMPONENT, keyEpochId: DIGEST,
    state: "succeeded-with-warnings", stateVersion: MAX_TRANSITIONS_PER_RUN,
    controlTransitionAllowance: input.controlTransitionAllowance,
    executionOwner: { pid: Number.MAX_SAFE_INTEGER, processStartTime: CODE, leaseNonce: CODE, attemptId: ATTEMPT, acquiredAt: AT },
    phaseSummaries: wide(phases, worstPhase),
    gateProofs: wide(phases, () => ({ gateProofId: GATE, gateId: COMPONENT, decision: "revised", decisionIndex: Number.MAX_SAFE_INTEGER, planDigest: DIGEST, reasonCode: COMPONENT })),
    brokerRequestSummaries: wide(exactCount(input.maximumBrokerRequests, "maximum broker requests"), () => ({ brokerRequestId: BROKER, attemptId: ATTEMPT, requestIndex: Number.MAX_SAFE_INTEGER, state: "settled" })),
    effectSummaries: wide(exactCount(input.maximumEffects, "maximum effects"), () => ({ attemptId: ATTEMPT, effectIndex: Number.MAX_SAFE_INTEGER, outcome: "already-applied", receiptDigest: DIGEST })),
    evidenceRefs: wide(exactCount(input.maximumEvidenceRefs, "maximum evidence refs"), worstEvidence),
    completeness: { requiredDeficit: Number.MAX_SAFE_INTEGER, optionalDeficit: Number.MAX_SAFE_INTEGER, classDigest: DIGEST },
    completionWarnings: wide(phases, () => ({ code: CODE, attempted: Number.MAX_SAFE_INTEGER, completed: Number.MAX_SAFE_INTEGER, skipped: Number.MAX_SAFE_INTEGER, failed: Number.MAX_SAFE_INTEGER })),
    notices: wide(phases, () => ({ code: CODE })),
    residualFindings: wide(phases, () => ({ code: CODE, phaseInstanceId: PHASE, evidence: worstEvidence() })),
    handoff: { handoffId: HANDOFF, bundleId: COMPONENT, bundleManifestDigest: DIGEST, finalTransitionHash: DIGEST },
    transitions: [], createdAt: AT, updatedAt: AT, integrity: "f".repeat(64),
  };
}

/** Add exact array separators and the full 2 KiB cap for every transition. */
function recordBytesAtTransitionCap(baseBytes: number, count: number): number {
  const bytes = baseBytes + count * MAX_PREPARATION_TRANSITION_ENVELOPE_BYTES + Math.max(0, count - 1);
  if (!Number.isSafeInteger(bytes)) throw new RunBudgetError("projected run byte arithmetic overflow");
  return bytes;
}

/** Return canonical whole-record ordinary bytes and bounded control delta. */
export function projectPreparationRunBudget(input: RunBudgetInput): RunBudget {
  if (input.maximumPhaseInstances > MAX_PHASE_INSTANCES_PER_RUN) throw new RunBudgetError("maximum phase instances exceed the launch ceiling");
  if (input.maximumEvidenceRefs > MAX_EVIDENCE_REFS_PER_RUN) throw new RunBudgetError("maximum evidence refs exceed the launch ceiling");
  const projectedTransitionCount = transitionCount(input);
  const controls = input.controlTransitionAllowance;
  const baseBytes = canonicalBytes(worstCaseRecordBase(input)).byteLength;
  const { ordinary, total, controlBytes } = budgetLanes(baseBytes,
    { total: projectedTransitionCount, controls }, recordBytesAtTransitionCap);
  if (ordinary > MAX_PREPARATION_RUN_BYTES - PREPARATION_RUN_CONTROL_RESERVE_BYTES) throw new RunBudgetError("projected ordinary run consumes reserved control headroom");
  if (controlBytes > PREPARATION_RUN_CONTROL_RESERVE_BYTES) throw new RunBudgetError("control transition allowance exceeds the 256 KiB control reserve");
  if (total > MAX_PREPARATION_RUN_BYTES) throw new RunBudgetError("projected run exceeds the 4 MiB record cap");
  return { projectedTransitionCount, projectedOrdinaryBytes: ordinary, projectedTotalBytes: total, remainingReserve: PREPARATION_RUN_CONTROL_RESERVE_BYTES - controlBytes };
}

/** Reject exact serialized bytes outside their ordinary or reserved lane. */
export function assertPreparationRunWriteBudget(bytes: number, budgetClass: RunWriteBudgetClass): void {
  exactCount(bytes, "serialized run bytes");
  if (bytes > MAX_PREPARATION_RUN_BYTES) throw new RunBudgetError("preparation run exceeds the 4 MiB record cap");
  if (budgetClass === "ordinary" && bytes > MAX_PREPARATION_RUN_BYTES - PREPARATION_RUN_CONTROL_RESERVE_BYTES) {
    throw new RunBudgetError("ordinary run write would consume reserved control headroom");
  }
}
