/**
 * @file src/operation-bundles/run-validation.ts
 * @description Closed transition-matrix, exact manifest-obligation replay, and
 * terminal-proof validation for HMAC-protected operation runs. This module
 * validates reconstructed data only; it performs no filesystem or key access.
 */

import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { MAX_MUTATIONS_PER_BUNDLE, MAX_RUN_TRANSITIONS, MAX_TRANSITION_ENVELOPE_BYTES } from "./constants.js";
import { compensationId, mutationId } from "./ids.js";
import { operationRunCounters, operationTransitionHash } from "./run-integrity.js";
import { operationRunWriteBudgetClass } from "./run-budget.js";
import { residualFindingsDigest } from "./run-residuals.js";
import { validateOperationRunOutcomes } from "./run-outcome-validation.js";
import { validateOperationRunTerminalProof } from "./run-terminal-validation.js";
import type {
  OperationRunContent, OperationRunState, OperationRunTransition,
  OperationTransitionPayload, OperationTransitionType, RunCompletionWarning,
} from "./run-types.js";

type Rule = {
  before: readonly OperationRunState[];
  after: OperationRunState;
  payload: OperationTransitionPayload["kind"];
};

const PRE_EFFECT = ["awaiting-approval", "approved", "approval-invalidated"] as const;
const RULES: Readonly<Record<Exclude<OperationTransitionType, "run-staged">, Rule>> = {
  approved: { before: ["awaiting-approval", "approval-invalidated"], after: "approved", payload: "authority" },
  "apply-started": { before: ["approved"], after: "applying", payload: "execution" },
  "mutation-started": { before: ["applying"], after: "applying", payload: "mutation" },
  "mutation-applied": { before: ["applying"], after: "applying", payload: "mutation" },
  "mutation-skipped-idempotent": { before: ["applying"], after: "applying", payload: "mutation" },
  "mutation-failed": { before: ["applying"], after: "applying", payload: "mutation" },
  "projection-started": { before: ["applying"], after: "applying", payload: "projection" },
  "projection-applied": { before: ["applying"], after: "applying", payload: "projection" },
  "projection-skipped-idempotent": { before: ["applying"], after: "applying", payload: "projection" },
  "projection-failed": { before: ["applying"], after: "applying", payload: "projection" },
  "recovery-required": { before: ["awaiting-approval", "approved", "applying", "compensating"], after: "recovery-required", payload: "problem" },
  "recovery-resumed": { before: ["recovery-required"], after: "applying", payload: "execution" },
  "compensation-began": { before: ["applying", "recovery-required"], after: "compensating", payload: "execution" },
  "compensation-started": { before: ["compensating"], after: "compensating", payload: "compensation" },
  "compensation-completed": { before: ["compensating"], after: "compensating", payload: "compensation" },
  "compensation-failed": { before: ["compensating"], after: "compensating", payload: "compensation" },
  succeeded: { before: ["applying"], after: "succeeded", payload: "none" },
  "succeeded-with-warnings": { before: ["applying"], after: "succeeded-with-warnings", payload: "none" },
  rejected: { before: PRE_EFFECT, after: "rejected", payload: "none" },
  superseded: { before: PRE_EFFECT, after: "superseded", payload: "none" },
  "approval-invalidated": { before: ["approved"], after: "approval-invalidated", payload: "problem" },
  cancelled: { before: PRE_EFFECT, after: "cancelled", payload: "none" },
  compensated: { before: ["compensating"], after: "compensated", payload: "none" },
  failed: { before: PRE_EFFECT, after: "failed", payload: "none" },
  recovered: { before: ["recovery-required"], after: "recovered", payload: "recovery" },
  abandoned: { before: ["recovery-required"], after: "abandoned", payload: "abandonment" },
  "notice-recorded": { before: ["applying"], after: "applying", payload: "notice" },
  "warning-recorded": { before: ["applying"], after: "applying", payload: "warning" },
};

/** Validate every cross-field invariant before a run can authorize behavior. */
export function validateOperationRun(run: OperationRunContent): void {
  validateObligations(run);
  validateTransitionChain(run);
  validateControlHeadroom(run);
  validateMetadataProjection(run);
  validateOperationRunOutcomes(run);
  const expected = operationRunCounters(run);
  if (!canonicalBytes(run.counters).equals(canonicalBytes(expected))) throw new Error("operation run counters are inconsistent");
  validateOperationRunTerminalProof(run);
}

/** Keep signed transition slots reserved for bounded recovery and retirement. */
function validateControlHeadroom(run: OperationRunContent): void {
  const allowance = run.controlTransitionAllowance;
  if (!Number.isSafeInteger(allowance) || allowance <= 0 || allowance >= MAX_RUN_TRANSITIONS) {
    throw new Error("control transition allowance is invalid");
  }
  let controls = 0;
  for (const [index, transition] of run.transitions.entries()) {
    if (operationRunWriteBudgetClass(transition.type) === "control") controls += 1;
    const ordinary = index + 1 - controls;
    const remaining = allowance - controls;
    if (controls > allowance || ordinary > MAX_RUN_TRANSITIONS - allowance
      || remaining < requiredControlSlots(transition.stateAfter)) {
      throw new Error("operation run consumed reserved control transition headroom");
    }
  }
}

/** Slots one reached state still needs to park and retire honestly. */
function requiredControlSlots(state: OperationRunState): number {
  if (terminalState(state)) return 0;
  if (state === "applying" || state === "compensating") return 2;
  return 1;
}

/** True only when no further transition is required for retirement. */
function terminalState(state: OperationRunState): boolean {
  return ["succeeded", "succeeded-with-warnings", "rejected", "superseded",
    "cancelled", "compensated", "failed", "recovered", "abandoned"].includes(state);
}

/** Require exact local-bundle IDs and closed manifest classifications. */
function validateObligations(run: OperationRunContent): void {
  const obligations = run.obligations;
  rejectDuplicates(obligations.authoritativeMutationIds, "duplicate authoritative mutation obligation");
  rejectDuplicates(obligations.projections.map((item) => item.mutationId), "duplicate projection obligation");
  rejectDuplicates(obligations.compensations.map((item) => item.compensationId), "duplicate compensation obligation");
  const workIds = [...obligations.authoritativeMutationIds, ...obligations.projections.map((item) => item.mutationId)];
  rejectDuplicates(workIds, "duplicate manifest work obligation");
  if (workIds.length > MAX_MUTATIONS_PER_BUNDLE) throw new Error("run obligations exceed manifest launch bounds");
  const expected = Array.from({ length: workIds.length }, (_, index) => mutationId(run.bundleId, index));
  if (!sameSet(workIds, expected)) throw new Error("run obligations contain a foreign or missing manifest mutation identity");
  for (const item of obligations.compensations) {
    if (!obligations.authoritativeMutationIds.includes(item.mutationId) || compensationId(item.mutationId) !== item.compensationId) {
      throw new Error("compensation obligation does not match an authoritative mutation");
    }
  }
}

/** Check genesis, exact rule tuple, sequence, hashes, and final projection. */
function validateTransitionChain(run: OperationRunContent): void {
  assertTransitionCount(run.transitions.length);
  for (const [index, transition] of run.transitions.entries()) {
    validateTransitionEnvelope(transition, index, run.transitions[index - 1]);
  }
  validateTransitionProjection(run);
}

/** Require genesis while retaining the global transition ceiling. */
function assertTransitionCount(length: number): void {
  if (length === 0 || length > MAX_RUN_TRANSITIONS) throw new Error("operation run requires a bounded genesis transition");
}

/** Validate one envelope's byte cap, content hash, and predecessor link. */
function validateTransitionEnvelope(transition: OperationRunTransition, index: number, prior?: OperationRunTransition): void {
  if (canonicalBytes(transition).byteLength > MAX_TRANSITION_ENVELOPE_BYTES) throw new Error("transition envelope exceeds the 2 KiB cap");
  if (operationTransitionHash(transition) !== transition.contentHash) throw new Error("transition content hash mismatch");
  validateTransitionLink(transition, index, prior);
}

/** Match current state, version, and timestamps to the chain endpoints. */
function validateTransitionProjection(run: OperationRunContent): void {
  const first = run.transitions[0]!, last = run.transitions.at(-1)!;
  if (run.stateVersion !== run.transitions.length || run.state !== last.stateAfter) throw new Error("stateVersion does not match transition chain");
  if (run.createdAt !== first.at || run.updatedAt !== last.at) throw new Error("run timestamps do not match transition chain");
}

/** Validate sequence, genesis handling, and the closed non-genesis rule. */
function validateTransitionLink(transition: OperationRunTransition, index: number, prior?: OperationRunTransition): void {
  if (transition.sequence !== index) throw new Error("transition sequence is not contiguous");
  if (index === 0) {
    validateGenesis(transition);
    return;
  }
  validatePriorLink(transition, prior);
  validateTransitionRule(transition);
  validateInvalidationCode(transition);
}

/** Bind one transition to the exact prior state and hash. */
function validatePriorLink(transition: OperationRunTransition, prior?: OperationRunTransition): void {
  if (prior === undefined || transition.previousHash !== prior.contentHash || transition.stateBefore !== prior.stateAfter) {
    throw new Error("transition chain is broken");
  }
}

/** Enforce the exact before/type/after/payload tuple. */
function validateTransitionRule(transition: OperationRunTransition): void {
  if (transition.type === "run-staged") throw new Error("run-staged is genesis-only");
  const rule = RULES[transition.type];
  if (!rule.before.includes(transition.stateBefore)) throw new Error("illegal state edge");
  if (transition.stateAfter !== rule.after) throw new Error("illegal state edge");
  if (transition.payload.kind !== rule.payload) throw new Error("transition payload does not match closed state edge");
}

/** Prevent approval invalidation from carrying another problem code. */
function validateInvalidationCode(transition: OperationRunTransition): void {
  if (transition.type !== "approval-invalidated") return;
  if (transition.payload.kind !== "problem") throw new Error("approval-invalidated transition requires its fixed problem code");
  if (transition.payload.code !== "approval-invalidated") throw new Error("approval-invalidated transition requires its fixed problem code");
}

/** Require the sole canonical staged genesis shape. */
function validateGenesis(transition: OperationRunTransition): void {
  if (transition.previousHash !== null || transition.type !== "run-staged" || transition.payload.kind !== "none"
    || transition.stateBefore !== "awaiting-approval" || transition.stateAfter !== "awaiting-approval") {
    throw new Error("invalid genesis transition");
  }
}

/** Replay authority, owner, and annotation fields from the transition chain. */
function validateMetadataProjection(run: OperationRunContent): void {
  const replay: MetadataReplay = { authority: null, owner: undefined, warnings: [], notices: [], residualBinding: undefined };
  for (const transition of run.transitions) {
    replayMetadataTransition(replay, transition);
  }
  assertMetadataProjection(run, replay);
  validateAnnotationState(run);
}

type MetadataReplay = {
  authority: OperationRunContent["authoritySnapshotDigest"];
  owner: OperationRunContent["applyOwner"];
  warnings: RunCompletionWarning[];
  notices: Array<{ code: string }>;
  residualBinding?: Extract<OperationTransitionPayload, { kind: "abandonment" }>;
};

/** Fold one transition into authority, owner, and annotation projections. */
function replayMetadataTransition(replay: MetadataReplay, transition: OperationRunTransition): void {
  assertExecutionAuthority(replay.authority, transition);
  replay.authority = projectedAuthority(replay.authority, transition);
  replay.owner = projectedOwner(replay.owner, transition);
  appendMetadataAnnotations(replay, transition.payload);
  assertActiveMetadata(transition.stateAfter, replay.authority, replay.owner);
}

/** Project the authority snapshot installed or cleared by one edge. */
function projectedAuthority(current: MetadataReplay["authority"], transition: OperationRunTransition) {
  const payload = transition.payload;
  const projected = payload.kind === "authority" ? payload.authoritySnapshotDigest : current;
  return clearsAuthority(transition.type) ? null : projected;
}

/** Execution may prove current approval authority but can never replace it. */
function assertExecutionAuthority(current: MetadataReplay["authority"], transition: OperationRunTransition): void {
  const payload = transition.payload;
  if (payload.kind === "execution" && (current === null || payload.authoritySnapshotDigest !== current)) {
    throw new Error("execution authority changed from the approved snapshot");
  }
}

/** Retain an owner only while execution remains active. */
function projectedOwner(current: MetadataReplay["owner"], transition: OperationRunTransition) {
  const active = transition.stateAfter === "applying" || transition.stateAfter === "compensating";
  if (!active) return undefined;
  return transition.payload.kind === "execution" ? transition.payload.applyOwner : current;
}

/** Append the exact warning, notice, or residual payload projection. */
function appendMetadataAnnotations(replay: MetadataReplay, payload: OperationTransitionPayload): void {
  if (payload.kind === "warning") replay.warnings.push({ code: payload.code, attempted: payload.attempted, completed: payload.completed, skipped: payload.skipped, failed: payload.failed });
  if (payload.kind === "notice") replay.notices.push({ code: payload.code });
  if (payload.kind === "abandonment") replay.residualBinding = payload;
}

/** Match persisted metadata fields to their transition-derived replay. */
function assertMetadataProjection(run: OperationRunContent, replay: MetadataReplay): void {
  if (run.authoritySnapshotDigest !== replay.authority) throw new Error("authority or apply owner does not match transitions");
  if (!sameOptionalCanonical(run.applyOwner, replay.owner)) throw new Error("authority or apply owner does not match transitions");
  if (!sameCanonical(run.completionWarnings, replay.warnings)) throw new Error("run annotations do not match transitions");
  if (!sameCanonical(run.notices, replay.notices)) throw new Error("run annotations do not match transitions");
  assertResidualProjection(run, replay.residualBinding);
}

/** Bind top-level HMAC-protected findings to the compact terminal payload. */
function assertResidualProjection(
  run: OperationRunContent,
  binding: MetadataReplay["residualBinding"],
): void {
  if (binding === undefined) {
    if (run.residualFindings.length > 0) throw new Error("run residual findings lack a transition binding");
    return;
  }
  if (binding.findingCount !== run.residualFindings.length
    || binding.findingsDigest !== residualFindingsDigest(run.residualFindings)) {
    throw new Error("run residual findings do not match transition binding");
  }
}

/** Identify pre-effect edges that invalidate durable approval authority. */
function clearsAuthority(type: OperationTransitionType): boolean {
  return ["approval-invalidated", "rejected", "superseded", "cancelled", "failed"].includes(type);
}

/** Require authority and ownership whenever work can be live. */
function assertActiveMetadata(state: OperationRunState, authority: unknown, owner: unknown): void {
  if (state === "approved" && authority === null) throw new Error("approved run requires an authority snapshot");
  if ((state === "applying" || state === "compensating") && (authority === null || owner === undefined)) {
    throw new Error("active run requires authority and applyOwner");
  }
}

/** Validate annotation counts and their allowed current states. */
function validateAnnotationState(run: OperationRunContent): void {
  validateAnnotationAllowance(run);
  validateWarningState(run);
  validateNoticeState(run);
  validateResidualState(run);
}

/** Keep warnings and notices inside their signed staging allowance. */
function validateAnnotationAllowance(run: OperationRunContent): void {
  const optional = run.obligations.projections.filter((item) => item.criticality === "optional").length;
  if (run.completionWarnings.length > optional || run.notices.length > run.controlTransitionAllowance) {
    throw new Error("run annotations exceed their signed worst-case allowance");
  }
}

/** Permit material completion warnings only while unsettled or warning-successful. */
function validateWarningState(run: OperationRunContent): void {
  if (run.completionWarnings.length === 0) return;
  if (run.state !== "succeeded-with-warnings" && !unsettled(run.state) && !retiredPostEffect(run.state)) {
    throw new Error("completion warnings are invalid for this state");
  }
}

/** Permit informational notices only while unsettled or successful. */
function validateNoticeState(run: OperationRunContent): void {
  if (run.notices.length === 0) return;
  if (!success(run.state) && !unsettled(run.state) && !retiredPostEffect(run.state)) {
    throw new Error("notices are invalid for this state");
  }
}

/** Restrict permanent residual findings to abandonment. */
function validateResidualState(run: OperationRunContent): void {
  if (run.state !== "abandoned" && run.residualFindings.length > 0) throw new Error("residual findings are invalid for this state");
}

/** True for either successful terminal state. */
function success(state: OperationRunState): boolean { return state === "succeeded" || state === "succeeded-with-warnings"; }
/**
 * The three UNSETTLED run states — execution or recovery can still continue and an
 * effect may be live. The single source of truth for the recovery gate's blocking
 * set and the read-only recovery resolver; every other run state is pre-effect or
 * terminal. A new run state added here must be classified deliberately at each
 * derived site rather than silently drifting the set.
 */
export const UNSETTLED_RUN_STATES: ReadonlySet<OperationRunState> = new Set([
  "applying", "recovery-required", "compensating",
]);

/** True while execution or recovery can still continue. */
function unsettled(state: OperationRunState): boolean { return UNSETTLED_RUN_STATES.has(state); }
/** True for honest post-effect terminals that preserve earlier annotations. */
function retiredPostEffect(state: OperationRunState): boolean { return state === "compensated" || state === "recovered" || state === "abandoned"; }

/** Compare identity collections after duplicate rejection. */
function sameSet(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((item) => right.includes(item)); }
/** Compare rebuilt JSON values through canonical byte identity. */
function sameCanonical(left: unknown, right: unknown): boolean { return canonicalBytes(left).equals(canonicalBytes(right)); }
/** Compare optional rebuilt values without conflating absence. */
function sameOptionalCanonical(left: unknown, right: unknown): boolean { return left === undefined || right === undefined ? left === right : sameCanonical(left, right); }
/** Reject duplicate exact identities with a caller-selected stable error. */
function rejectDuplicates(items: readonly string[], message: string): void { if (new Set(items).size !== items.length) throw new Error(message); }
