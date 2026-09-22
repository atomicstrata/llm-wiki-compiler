/**
 * @file src/preparations/run-parse-helpers.ts
 * @description Granular exact-shape value, transition, and summary parsers for
 * the version-one preparation-run grammar (design sections 12.3, 13.1, 13.2).
 * Every stored derived identity that can be recomputed from run-local inputs is
 * RE-DERIVED through Task 1's `derive*` primitives and compared, not merely
 * shape-checked: a caller-supplied `sha256:`-shaped identity that does not
 * recompute is an integrity-invalid rejection. Nothing is spread from untrusted
 * input; every field is named and rebuilt.
 */

import {
  count, enumValue, exact, record, textValue, type JsonRecord,
} from "../operation-bundles/manifest-values.js";
import { assertBundleId, assertOperationRunId } from "../operation-bundles/ids.js";
import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { isSignalablePid } from "../utils/lock-owner.js";
import { canonicalTime, warningFields as readWarningFields } from "../operation-bundles/run-values.js";
export { canonicalTime } from "../operation-bundles/run-values.js";
import { parseEffectId, parseSha256Digest } from "../capability-providers/ids.js";
import {
  assertAttemptId, assertBrokerRequestId, assertGateProofId, assertHandoffId,
  assertPhaseInstanceId, assertPreparationId, assertSafeComponent, deriveAttemptId,
  deriveBrokerRequestId, deriveGateProofId, deriveHandoffId,
  type PreparationRunId,
} from "./ids.js";
import { evidenceRef } from "./plan-parse-helpers.js";
import { MAX_PREPARATION_TRANSITION_ENVELOPE_BYTES } from "./constants.js";
import { preparationTransitionHash } from "./run-integrity.js";
import {
  PHASE_INSTANCE_STATES, PREPARATION_RUN_PROBLEM_CODES, PREPARATION_RUN_STATES,
  PREPARATION_TRANSITION_TYPES,
} from "./run-types.js";
import type {
  BrokerRequestSummaryV1, CompletenessRecordV1, EffectSummaryV1,
  GateProofSummaryV1, HandoffBindingV1, PhaseSummaryV1, PreparationExecutionOwnerV1,
  PreparationPrincipalV1, PreparationRunState, PreparationRunTransitionV1,
  PreparationTransitionPayload, PreparationTransitionType, ResidualFindingV1,
  RunCompletionWarningV1, RunNoticeV1,
} from "./run-types.js";
import type { EvidenceRefV1, Sha256Digest } from "./types.js";

const MAX_CODE_BYTES = 128;
const EFFECT_OUTCOMES = [
  "planned", "started", "applied", "already-applied", "refused", "unavailable",
  "failed", "outcome-unknown",
] as const;
const GATE_DECISIONS = ["approved", "rejected", "revised"] as const;
const BROKER_STATES = ["started", "settled", "unavailable"] as const;

/** Parse one branded canonical sha256 digest field. */
export function runDigest(value: unknown, label: string): Sha256Digest {
  try {
    return parseSha256Digest(value);
  } catch {
    throw new Error(`${label} must be a canonical sha256 digest`);
  }
}

/** Parse one run-state member of the closed vocabulary. */
export function runState(value: unknown): PreparationRunState {
  return enumValue(value, PREPARATION_RUN_STATES, "preparation run state");
}

/** Parse the actor principal recorded on a transition. */
export function parsePrincipal(value: unknown): PreparationPrincipalV1 {
  const obj = record(value, "transition actor");
  exact(obj, ["id", "surface"]);
  return {
    id: textValue(obj.id, "principal id", MAX_CODE_BYTES),
    surface: textValue(obj.surface, "principal surface", MAX_CODE_BYTES),
  };
}

/** Parse the advisory executor owner and re-derive its attempt identity is not possible here. */
export function parseExecutionOwner(value: unknown): PreparationExecutionOwnerV1 {
  const obj = record(value, "executionOwner");
  exact(obj, ["pid", "leaseNonce", "attemptId", "acquiredAt"], ["processStartTime"]);
  // THROUGH THE SAME PREDICATE THE LIVENESS PROBE IS GATED ON, not a local rule:
  // `count` admits any nonnegative safe integer, so this record could carry a pid
  // far above what `process.kill` accepts as an ARGUMENT — and that throws a
  // TypeError with no errno, which the probe reads as a dead process. For an
  // execution owner that is the DESTRUCTIVE direction: a possibly-live executor
  // parked and its fence cleared. The bespoke `pid === 0` check this replaces
  // closed one end of the same class and left the other open.
  const pid = count(obj.pid, "executionOwner pid");
  if (!isSignalablePid(pid)) throw new Error("executionOwner pid is not a signalable process id");
  const processStartTime = obj.processStartTime === undefined
    ? undefined : textValue(obj.processStartTime, "executionOwner processStartTime", MAX_CODE_BYTES);
  return {
    pid, leaseNonce: textValue(obj.leaseNonce, "executionOwner leaseNonce", MAX_CODE_BYTES),
    attemptId: assertAttemptId(obj.attemptId), acquiredAt: canonicalTime(obj.acquiredAt, "executionOwner acquiredAt"),
    ...(processStartTime === undefined ? {} : { processStartTime }),
  };
}

/**
 * Parse one optional durable spend dimension. Absence is the honest
 * "unobserved" record and is preserved as absence; a PRESENT value must be a
 * bounded nonnegative integer, so a negative, fractional, or non-numeric
 * measurement is an integrity-invalid rejection rather than a figure a cost
 * preview would go on to report as fact.
 */
function optionalSpend(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : count(value, label);
}

/**
 * Every field name a stored phase summary may carry.
 *
 * EXPORTED because a second module has to agree with it: the staging-time byte
 * budget in `run-budget.ts` proves a plan's worst-case record fits the 4 MiB cap,
 * and that proof is only sound if its widest phase summary carries every field
 * this parser will later accept. Adding a field here and not there under-charges
 * the admission proof, so a plan admitted at the boundary would strand mid-run on
 * the write budget. One list, read by the parser below and by the budget's
 * worst-case literal, with a structural test pinning the agreement.
 */
export const PHASE_SUMMARY_REQUIRED_FIELDS = Object.freeze([
  "phaseInstanceId", "logicalPhaseId", "state", "disposition", "attemptCount",
  "invocationCount", "brokerRequestCount", "effectCount",
] as const);

export const PHASE_SUMMARY_OPTIONAL_FIELDS = Object.freeze([
  "currentAttemptId", "outputEvidenceDigest", "checkpointDigest", "tokenCount", "costMicros",
  "problem", "problemDetail",
] as const);

/** Parse one phase summary, re-deriving the current attempt identity. */
export function parsePhaseSummary(value: unknown): PhaseSummaryV1 {
  const obj = record(value, "phase summary");
  exact(obj, PHASE_SUMMARY_REQUIRED_FIELDS, PHASE_SUMMARY_OPTIONAL_FIELDS);
  const phaseInstanceId = assertPhaseInstanceId(obj.phaseInstanceId);
  const attemptCount = count(obj.attemptCount, "phase attemptCount");
  const currentAttemptId = obj.currentAttemptId === undefined
    ? undefined : reDeriveCurrentAttempt(phaseInstanceId, attemptCount, obj.currentAttemptId);
  const tokenCount = optionalSpend(obj.tokenCount, "phase tokenCount");
  const costMicros = optionalSpend(obj.costMicros, "phase costMicros");
  return {
    phaseInstanceId, logicalPhaseId: assertSafeComponent(obj.logicalPhaseId),
    state: enumValue(obj.state, PHASE_INSTANCE_STATES, "phase state"),
    disposition: enumValue(obj.disposition, ["required", "optional"] as const, "phase disposition"),
    attemptCount, invocationCount: count(obj.invocationCount, "phase invocationCount"),
    brokerRequestCount: count(obj.brokerRequestCount, "phase brokerRequestCount"),
    effectCount: count(obj.effectCount, "phase effectCount"),
    ...(currentAttemptId === undefined ? {} : { currentAttemptId }),
    ...(obj.outputEvidenceDigest === undefined ? {} : { outputEvidenceDigest: runDigest(obj.outputEvidenceDigest, "phase outputEvidenceDigest") }),
    ...(obj.checkpointDigest === undefined ? {} : { checkpointDigest: runDigest(obj.checkpointDigest, "phase checkpointDigest") }),
    ...(tokenCount === undefined ? {} : { tokenCount }),
    ...(costMicros === undefined ? {} : { costMicros }),
    ...(obj.problem === undefined ? {} : { problem: textValue(obj.problem, "phase problem", 128) }),
    // 516: the writer caps the detail at 512 BYTES and appends a one-character
    // ellipsis when it truncates, so the parse cap must sit above the writer's
    // or a truncated record would be refused by its own reader.
    ...(obj.problemDetail === undefined ? {} : { problemDetail: textValue(obj.problemDetail, "phase problemDetail", 516) }),
  };
}

/** Re-derive the current attempt id from the phase instance and attempt count. */
function reDeriveCurrentAttempt(phaseInstanceId: PhaseSummaryV1["phaseInstanceId"], attemptCount: number, stored: unknown) {
  const asserted = assertAttemptId(stored);
  if (attemptCount === 0) throw new Error("phase summary has a current attempt with zero attempts");
  if (deriveAttemptId(phaseInstanceId, attemptCount - 1) !== asserted) {
    throw new Error("phase current attempt id does not recompute");
  }
  return asserted;
}

/** Parse one gate proof, re-deriving its identity and validating the full binding. */
export function parseGateProof(value: unknown, runId: PreparationRunId): GateProofSummaryV1 {
  const obj = record(value, "gate proof");
  exact(obj, ["gateProofId", "gateId", "decision", "decisionIndex", "planDigest", "phaseDigest", "inputDigest", "authorityDigest", "actor", "at"], ["effectDigest", "reasonCode"]);
  const gateId = assertSafeComponent(obj.gateId);
  const planDigest = runDigest(obj.planDigest, "gate proof planDigest");
  const decisionIndex = count(obj.decisionIndex, "gate decisionIndex");
  const gateProofId = assertGateProofId(obj.gateProofId);
  if (deriveGateProofId({ runId, gateId, planDigest, decisionIndex }) !== gateProofId) {
    throw new Error("gate proof id does not recompute");
  }
  return {
    gateProofId, gateId, decision: enumValue(obj.decision, GATE_DECISIONS, "gate decision"), decisionIndex, planDigest,
    phaseDigest: runDigest(obj.phaseDigest, "gate proof phaseDigest"),
    inputDigest: runDigest(obj.inputDigest, "gate proof inputDigest"), authorityDigest: runDigest(obj.authorityDigest, "gate proof authorityDigest"),
    actor: parsePrincipal(obj.actor), at: canonicalTime(obj.at, "gate proof at"),
    ...(obj.effectDigest === undefined ? {} : { effectDigest: runDigest(obj.effectDigest, "gate proof effectDigest") }),
    // THROUGH THE SAME BOUNDED-COMPONENT READER every other operator-supplied
    // label on this record goes through, so a reason code cannot smuggle control
    // characters, unbounded length, or non-well-formed text onto a signed leaf.
    ...(obj.reasonCode === undefined ? {} : { reasonCode: assertSafeComponent(obj.reasonCode) }),
  };
}

/** Parse one broker request summary, re-deriving its identity from its attempt. */
export function parseBrokerSummary(value: unknown): BrokerRequestSummaryV1 {
  const obj = record(value, "broker request summary");
  exact(obj, ["brokerRequestId", "attemptId", "requestIndex", "state"]);
  const attemptId = assertAttemptId(obj.attemptId);
  const requestIndex = count(obj.requestIndex, "broker requestIndex");
  const brokerRequestId = assertBrokerRequestId(obj.brokerRequestId);
  if (deriveBrokerRequestId(attemptId, requestIndex) !== brokerRequestId) {
    throw new Error("broker request id does not recompute");
  }
  return { brokerRequestId, attemptId, requestIndex, state: enumValue(obj.state, BROKER_STATES, "broker state") };
}

/** Parse one effect summary and its Provider V2 receipt reference. */
export function parseEffectSummary(value: unknown): EffectSummaryV1 {
  const obj = record(value, "effect summary");
  exact(obj, ["attemptId", "effectIndex", "outcome"], ["effectId", "claimDigest", "brokerRequestId", "receiptDigest"]);
  return {
    attemptId: assertAttemptId(obj.attemptId), effectIndex: count(obj.effectIndex, "effect effectIndex"),
    outcome: enumValue(obj.outcome, EFFECT_OUTCOMES, "effect outcome"),
    ...(obj.effectId === undefined ? {} : { effectId: parseEffectId(obj.effectId) }),
    ...(obj.claimDigest === undefined ? {} : { claimDigest: runDigest(obj.claimDigest, "effect claimDigest") }),
    ...(obj.brokerRequestId === undefined ? {} : { brokerRequestId: assertBrokerRequestId(obj.brokerRequestId) }),
    ...(obj.receiptDigest === undefined ? {} : { receiptDigest: runDigest(obj.receiptDigest, "effect receiptDigest") }),
  };
}

/** Parse the host-authored completeness record. */
export function parseCompleteness(value: unknown): CompletenessRecordV1 {
  const obj = record(value, "completeness");
  exact(obj, ["requiredDeficit", "optionalDeficit"], ["classDigest"]);
  return {
    requiredDeficit: count(obj.requiredDeficit, "completeness requiredDeficit"),
    optionalDeficit: count(obj.optionalDeficit, "completeness optionalDeficit"),
    ...(obj.classDigest === undefined ? {} : { classDigest: runDigest(obj.classDigest, "completeness classDigest") }),
  };
}

/** Parse one completion warning and reconcile its counters. */
export function parseWarning(value: unknown): RunCompletionWarningV1 {
  const obj = record(value, "completion warning");
  exact(obj, ["code", "attempted", "completed", "skipped", "failed"]);
  return warningFields(obj);
}

/** Parse the same counted warning fields in standalone records and payloads. */
function warningFields(obj: JsonRecord): RunCompletionWarningV1 {
  return readWarningFields(obj, MAX_CODE_BYTES);
}

/** Parse one fixed-code informational notice. */
export function parseNotice(value: unknown): RunNoticeV1 {
  const obj = record(value, "notice");
  exact(obj, ["code"]);
  return { code: textValue(obj.code, "notice code", MAX_CODE_BYTES) };
}

/** Parse one bounded permanent residual observation. */
export function parseResidual(value: unknown): ResidualFindingV1 {
  const obj = record(value, "residual finding");
  exact(obj, ["code"], ["phaseInstanceId", "evidence"]);
  const phaseInstanceId = obj.phaseInstanceId === undefined ? undefined : assertPhaseInstanceId(obj.phaseInstanceId);
  const evidence = obj.evidence === undefined ? undefined : evidenceRef(obj.evidence, "residual evidence");
  return {
    code: textValue(obj.code, "residual code", MAX_CODE_BYTES),
    ...(phaseInstanceId === undefined ? {} : { phaseInstanceId }),
    ...(evidence === undefined ? {} : { evidence }),
  };
}

/** Parse the handoff binding, re-deriving its identity from the run and hash. */
export function parseHandoff(value: unknown, runId: PreparationRunId): HandoffBindingV1 {
  const obj = record(value, "handoff");
  exact(obj, ["handoffId", "bundleId", "bundleManifestDigest", "finalTransitionHash"]);
  const finalTransitionHash = runDigest(obj.finalTransitionHash, "handoff finalTransitionHash");
  const handoffId = assertHandoffId(obj.handoffId);
  if (deriveHandoffId(runId, finalTransitionHash) !== handoffId) {
    throw new Error("handoff id does not recompute");
  }
  return {
    handoffId, bundleId: assertSafeComponent(obj.bundleId),
    bundleManifestDigest: runDigest(obj.bundleManifestDigest, "handoff bundleManifestDigest"), finalTransitionHash,
  };
}

/** Parse one evidence reference through the shared closed evidence grammar. */
export function parseEvidence(value: unknown): EvidenceRefV1 {
  return evidenceRef(value, "run evidence");
}

type PayloadParser = (obj: JsonRecord, runId: PreparationRunId) => PreparationTransitionPayload;

const PAYLOAD_PARSERS: Readonly<Record<PreparationTransitionType, PayloadParser>> = {
  "run-planned": nonePayload, "gate-blocked": nonePayload, "gate-decided": gatePayload,
  "phase-started": phasePayload, "phase-progressed": phasePayload, "phase-settled": phasePayload,
  paused: nonePayload, resumed: nonePayload, "recovery-required": problemPayload,
  "recovery-resumed": nonePayload, "handoff-ready": nonePayload, "handoff-started": handoffStartedPayload,
  "handed-off": handoffPayload, succeeded: nonePayload, "succeeded-with-warnings": nonePayload,
  cancelling: nonePayload, cancelled: nonePayload, "cancelled-with-effects": nonePayload,
  superseded: supersedePayload, abandoned: abandonmentPayload, failed: nonePayload,
  "headroom-exhausted": problemPayload, "notice-recorded": noticePayload,
  "warning-recorded": warningPayload,
};

/** Parse the exact payload grammar selected by the closed transition vocabulary. */
function parsePayload(
  type: PreparationTransitionType, value: unknown, runId: PreparationRunId,
): PreparationTransitionPayload {
  const parser = PAYLOAD_PARSERS[type];
  if (parser === undefined) throw new Error("transition type has no payload grammar");
  return parser(record(value, "transition payload"), runId);
}

/** Parse the empty payload used by genesis and simple control edges. */
function nonePayload(obj: JsonRecord): PreparationTransitionPayload {
  exact(obj, ["kind"]);
  if (obj.kind !== "none") throw new Error("transition payload kind mismatch");
  return { kind: "none" };
}

/** Parse one closed preparation-run problem code. */
function problemPayload(obj: JsonRecord): PreparationTransitionPayload {
  exact(obj, ["kind", "code"]);
  if (obj.kind !== "problem") throw new Error("transition payload kind mismatch");
  return { kind: "problem", code: enumValue(obj.code, PREPARATION_RUN_PROBLEM_CODES, "problem code") };
}

/** Parse one phase transition payload. */
function phasePayload(obj: JsonRecord): PreparationTransitionPayload {
  exact(obj, ["kind", "phaseInstanceId", "phaseState"]);
  if (obj.kind !== "phase") throw new Error("transition payload kind mismatch");
  return {
    kind: "phase", phaseInstanceId: assertPhaseInstanceId(obj.phaseInstanceId),
    phaseState: enumValue(obj.phaseState, PHASE_INSTANCE_STATES, "phase state"),
  };
}

/** Parse one gate-decision transition payload. */
function gatePayload(obj: JsonRecord): PreparationTransitionPayload {
  exact(obj, ["kind", "gateProofId", "decision"]);
  if (obj.kind !== "gate") throw new Error("transition payload kind mismatch");
  return { kind: "gate", gateProofId: assertGateProofId(obj.gateProofId), decision: enumValue(obj.decision, GATE_DECISIONS, "gate decision") };
}

/** Parse one counted optional-work warning payload. */
function warningPayload(obj: JsonRecord): PreparationTransitionPayload {
  exact(obj, ["kind", "code", "attempted", "completed", "skipped", "failed"]);
  if (obj.kind !== "warning") throw new Error("transition payload kind mismatch");
  return { kind: "warning", ...warningFields(obj) };
}

/** Parse one informational notice payload. */
function noticePayload(obj: JsonRecord): PreparationTransitionPayload {
  exact(obj, ["kind", "code"]);
  if (obj.kind !== "notice") throw new Error("transition payload kind mismatch");
  return { kind: "notice", code: textValue(obj.code, "notice code", MAX_CODE_BYTES) };
}

/** Parse one supersession transition payload. */
function supersedePayload(obj: JsonRecord): PreparationTransitionPayload {
  exact(obj, ["kind", "supersededByPreparationId"]);
  if (obj.kind !== "supersede") throw new Error("transition payload kind mismatch");
  return { kind: "supersede", supersededByPreparationId: assertPreparationId(obj.supersededByPreparationId) };
}

/**
 * Parse the reserved-identity `handoff-started` recovery-authority payload. Every
 * durable field is re-validated against its exact grammar: the bundle and run
 * identities are MA-owned ULIDs, the handoff id and all digests recompute their
 * own shape, and — symmetrically with {@link parseHandoff} — the handoff id is
 * re-derived from the run id and pre-handoff chain tip, so a tampered payload
 * cannot smuggle a mismatched reserved identity. The `genesisAuthorityDigest`
 * pins the genesis-run authority the reserved bundle is created with.
 */
function handoffStartedPayload(obj: JsonRecord, runId: PreparationRunId): PreparationTransitionPayload {
  exact(obj, [
    "kind", "handoffId", "reservedBundleId", "reservedOperationRunId", "bundleManifestDigest",
    "genesisAuthorityDigest", "preHandoffTransitionHash", "originEvidenceDigest", "evidenceCopyDigest",
  ]);
  if (obj.kind !== "handoff-started") throw new Error("transition payload kind mismatch");
  const preHandoffTransitionHash = runDigest(obj.preHandoffTransitionHash, "handoff-started preHandoffTransitionHash");
  const handoffId = assertHandoffId(obj.handoffId);
  if (deriveHandoffId(runId, preHandoffTransitionHash) !== handoffId) {
    throw new Error("handoff-started handoff id does not recompute");
  }
  return {
    kind: "handoff-started", handoffId,
    reservedBundleId: assertBundleId(obj.reservedBundleId),
    reservedOperationRunId: assertOperationRunId(obj.reservedOperationRunId),
    bundleManifestDigest: runDigest(obj.bundleManifestDigest, "handoff-started bundleManifestDigest"),
    genesisAuthorityDigest: runDigest(obj.genesisAuthorityDigest, "handoff-started genesisAuthorityDigest"),
    preHandoffTransitionHash,
    originEvidenceDigest: runDigest(obj.originEvidenceDigest, "handoff-started originEvidenceDigest"),
    evidenceCopyDigest: runDigest(obj.evidenceCopyDigest, "handoff-started evidenceCopyDigest"),
  };
}

/** Parse one handoff-settlement transition payload. */
function handoffPayload(obj: JsonRecord): PreparationTransitionPayload {
  exact(obj, ["kind", "handoffId", "bundleManifestDigest"]);
  if (obj.kind !== "handoff") throw new Error("transition payload kind mismatch");
  return { kind: "handoff", handoffId: assertHandoffId(obj.handoffId), bundleManifestDigest: runDigest(obj.bundleManifestDigest, "handoff bundleManifestDigest") };
}

/** Parse explicit residual-state confirmation and its finding count. */
function abandonmentPayload(obj: JsonRecord): PreparationTransitionPayload {
  exact(obj, ["kind", "confirmation", "findingCount"]);
  if (obj.kind !== "abandonment" || obj.confirmation !== "confirm-residual-state") {
    throw new Error("abandonment confirmation mismatch");
  }
  return { kind: "abandonment", confirmation: "confirm-residual-state", findingCount: count(obj.findingCount, "abandonment findingCount") };
}

/** Parse and hash-check one bounded transition envelope. */
export function parseTransition(value: unknown, runId: PreparationRunId): PreparationRunTransitionV1 {
  if (canonicalBytes(value).byteLength > MAX_PREPARATION_TRANSITION_ENVELOPE_BYTES) {
    throw new Error("transition envelope exceeds the 2 KiB cap");
  }
  const obj = record(value, "transition");
  exact(obj, ["sequence", "previousHash", "contentHash", "actor", "stateBefore", "stateAfter", "type", "at", "payload"]);
  const type = enumValue(obj.type, PREPARATION_TRANSITION_TYPES, "transition type");
  const transition: PreparationRunTransitionV1 = {
    sequence: count(obj.sequence, "transition sequence"),
    previousHash: obj.previousHash === null ? null : runDigest(obj.previousHash, "previousHash"),
    contentHash: runDigest(obj.contentHash, "contentHash"), actor: parsePrincipal(obj.actor),
    stateBefore: runState(obj.stateBefore), stateAfter: runState(obj.stateAfter), type,
    at: canonicalTime(obj.at, "transition at"), payload: parsePayload(type, obj.payload, runId),
  };
  if (preparationTransitionHash(transition) !== transition.contentHash) {
    throw new Error("transition content hash mismatch");
  }
  return transition;
}
