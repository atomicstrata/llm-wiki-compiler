/**
 * @file src/operation-bundles/run-parse.ts
 * @description Bounded duplicate-key-free parser for the exact operation-run
 * grammar. It rebuilds allowlisted DTOs, verifies every transition hash and
 * legal edge, replays monotonic outcomes, checks counters, and rejects false
 * terminal success before callers can trust run state.
 */

import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { canonicalTime, warningFields } from "./run-values.js";
import { parseBoundedUniqueJson } from "../profile/templates/signing/json.js";
import { MAX_MUTATIONS_PER_BUNDLE, MAX_RUN_BYTES, MAX_RUN_EVIDENCE_BLOB_BYTES, MAX_RUN_TRANSITIONS, MAX_TRANSITION_ENVELOPE_BYTES } from "./constants.js";
import { assertBundleId, assertOperationRunId, compensationId, type CompensationId, type MutationId } from "./ids.js";
import { array, count, digest, enumValue, exact, record, textValue, type JsonRecord } from "./manifest-values.js";
import { assertWorkspaceId } from "./paths.js";
import { OPERATION_GRANTS, OPERATION_PRINCIPAL_SURFACES, type OperationGrant, type OperationPrincipal } from "./principal.js";
import { OPERATION_PROBLEM_CODES } from "./problems.js";
import { operationRunBindingMatches, operationTransitionHash } from "./run-integrity.js";
import { validateOperationRun } from "./run-validation.js";
import {
  OPERATION_RUN_STATES, OPERATION_TRANSITION_TYPES, type CompensationOutcome,
  type OperationEvidenceReference,
  type MutationOutcome, type OperationRun, type OperationRunBinding,
  type OperationRunContent, type OperationRunCounters, type OperationRunState,
  type OperationRunTransition, type OperationTransitionPayload,
  type OperationTransitionType, type ProjectionOutcome, type RunEvidenceRef,
} from "./run-types.js";
import type { OperationDigest } from "./types.js";

const TOP_KEYS = ["schemaVersion", "runId", "bundleId", "manifestDigest", "workspaceId", "keyEpochId", "state", "stateVersion", "controlTransitionAllowance", "authoritySnapshotDigest", "obligations", "mutationOutcomes", "compensationOutcomes", "projectionOutcomes", "counters", "completionWarnings", "notices", "residualFindings", "transitions", "createdAt", "updatedAt", "integrity"] as const;
const MUTATION_ID = /^opm_[0-9a-f]{64}$/;
const COMPENSATION_ID = /^opc_[0-9a-f]{64}$/;
const HMAC = /^[0-9a-f]{64}$/;
const MAX_CODE_BYTES = 128;
const MAX_DETAIL_BYTES = 512;

/** Rebuild and validate one complete version-one operation run. */
export function parseOperationRun(text: string, binding?: OperationRunBinding): OperationRun {
  const root = record(parseBoundedUniqueJson(text, MAX_RUN_BYTES), "operation run");
  exact(root, TOP_KEYS, ["applyOwner"]);
  if (root.schemaVersion !== 1) throw new Error("operation run schemaVersion must be 1");
  const run = parseRunFields(root);
  validateOperationRun(run);
  if (binding !== undefined && !operationRunBindingMatches(run, binding)) {
    throw new Error("operation run binding mismatch");
  }
  return run;
}

/** Rebuild one exact bounded residual observation before evidence custody I/O. */
export function parseAbandonmentObservation(value: unknown) {
  const obj = record(value, "abandonment observation");
  try {
    exact(obj, ["code", "mutationId", "evidence"]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid field";
    throw new Error(`abandonment observation field is invalid: ${detail}`);
  }
  return {
    code: textValue(obj.code, "residual code", MAX_CODE_BYTES),
    mutationId: mutationIdentity(obj.mutationId),
    evidence: parseStoredEvidence(obj.evidence),
  };
}

/** Rebuild top-level fields without retaining caller-owned objects. */
function parseRunFields(root: JsonRecord): OperationRun {
  const authority = root.authoritySnapshotDigest === null ? null : digest(root.authoritySnapshotDigest, "authoritySnapshotDigest");
  const applyOwner = root.applyOwner === undefined ? undefined : parseApplyOwner(root.applyOwner);
  const integrity = textValue(root.integrity, "integrity", 64);
  if (!HMAC.test(integrity)) throw new Error("integrity must be lowercase HMAC-SHA256");
  return {
    schemaVersion: 1, runId: assertOperationRunId(root.runId), bundleId: assertBundleId(root.bundleId),
    manifestDigest: digest(root.manifestDigest, "manifestDigest"), workspaceId: assertWorkspaceId(root.workspaceId),
    keyEpochId: digest(root.keyEpochId, "keyEpochId"), state: state(root.state), stateVersion: count(root.stateVersion, "stateVersion"),
    controlTransitionAllowance: count(root.controlTransitionAllowance, "controlTransitionAllowance"),
    authoritySnapshotDigest: authority, obligations: parseObligations(root.obligations),
    mutationOutcomes: parseMutationOutcomes(root.mutationOutcomes), compensationOutcomes: parseCompensationOutcomes(root.compensationOutcomes),
    projectionOutcomes: parseProjectionOutcomes(root.projectionOutcomes), counters: parseCounters(root.counters),
    completionWarnings: array(root.completionWarnings, "completionWarnings", MAX_MUTATIONS_PER_BUNDLE).map(parseWarning),
    notices: array(root.notices, "notices", MAX_MUTATIONS_PER_BUNDLE).map(parseNotice),
    residualFindings: array(root.residualFindings, "residualFindings", MAX_MUTATIONS_PER_BUNDLE).map(parseResidual),
    transitions: array(root.transitions, "transitions", MAX_RUN_TRANSITIONS).map(parseTransition),
    ...(applyOwner === undefined ? {} : { applyOwner }), createdAt: canonicalTime(root.createdAt, "createdAt"),
    updatedAt: canonicalTime(root.updatedAt, "updatedAt"), integrity,
  };
}

/** Parse exact manifest-derived work identities used by terminal validation. */
function parseObligations(value: unknown): OperationRunContent["obligations"] {
  const obj = record(value, "obligations");
  exact(obj, ["authoritativeMutationIds", "compensations", "projections"]);
  const authoritativeMutationIds = array(obj.authoritativeMutationIds, "authoritativeMutationIds", MAX_MUTATIONS_PER_BUNDLE)
    .map(mutationIdentity);
  const compensations = array(obj.compensations, "compensations", MAX_MUTATIONS_PER_BUNDLE).map(parseCompensationObligation);
  const projections = array(obj.projections, "projections", MAX_MUTATIONS_PER_BUNDLE).map(parseProjectionObligation);
  if (authoritativeMutationIds.length + projections.length > MAX_MUTATIONS_PER_BUNDLE) {
    throw new Error("run obligations exceed manifest launch bounds");
  }
  return { authoritativeMutationIds, compensations, projections };
}

/** Parse one compensation identity pair derived from a mutation. */
function parseCompensationObligation(value: unknown) {
  const obj = record(value, "compensation obligation");
  exact(obj, ["compensationId", "mutationId"]);
  const mutationId = mutationIdentity(obj.mutationId), compensation = compensationIdentity(obj.compensationId);
  if (compensationId(mutationId) !== compensation) throw new Error("compensation obligation identity mismatch");
  return { compensationId: compensation, mutationId };
}

/** Parse one projection identity and its immutable criticality. */
function parseProjectionObligation(value: unknown) {
  const obj = record(value, "projection obligation");
  exact(obj, ["mutationId", "criticality"]);
  return { mutationId: mutationIdentity(obj.mutationId), criticality: enumValue(obj.criticality, ["required", "optional"] as const, "projection criticality") };
}

/** Parse a principal independently of its transport configuration source. */
function parsePrincipal(value: unknown): OperationPrincipal {
  const obj = record(value, "transition actor");
  exact(obj, ["id", "surface", "grants"]);
  const grants = array(obj.grants, "principal grants", OPERATION_GRANTS.length)
    .map((grant) => enumValue(grant, OPERATION_GRANTS, "operation grant") as OperationGrant);
  if (new Set(grants).size !== grants.length) throw new Error("principal grants contain duplicates");
  return { id: textValue(obj.id, "principal id", MAX_CODE_BYTES), surface: enumValue(obj.surface, OPERATION_PRINCIPAL_SURFACES, "principal surface"), grants };
}

/** Parse and hash-check one bounded transition envelope. */
function parseTransition(value: unknown): OperationRunTransition {
  if (canonicalBytes(value).byteLength > MAX_TRANSITION_ENVELOPE_BYTES) {
    throw new Error("transition envelope exceeds the 2 KiB cap");
  }
  const obj = record(value, "transition");
  exact(obj, ["sequence", "previousHash", "contentHash", "actor", "stateBefore", "stateAfter", "type", "at", "payload"]);
  const type = enumValue(obj.type, OPERATION_TRANSITION_TYPES, "transition type") as OperationTransitionType;
  const transition: OperationRunTransition = {
    sequence: count(obj.sequence, "transition sequence"), previousHash: obj.previousHash === null ? null : digest(obj.previousHash, "previousHash"),
    contentHash: digest(obj.contentHash, "contentHash"), actor: parsePrincipal(obj.actor), stateBefore: state(obj.stateBefore),
    stateAfter: state(obj.stateAfter), type, at: canonicalTime(obj.at, "transition at"), payload: parsePayload(type, obj.payload),
  };
  if (operationTransitionHash(transition) !== transition.contentHash) throw new Error("transition content hash mismatch");
  return transition;
}

type PayloadParser = (obj: JsonRecord) => OperationTransitionPayload;

const PAYLOAD_PARSERS: Readonly<Record<OperationTransitionType, PayloadParser>> = {
  "run-staged": parseNonePayload, approved: parseAuthorityPayload,
  "apply-started": parseExecutionPayload, "mutation-started": parseMutationPayload,
  "mutation-applied": parseMutationPayload, "mutation-skipped-idempotent": parseMutationPayload,
  "mutation-failed": parseMutationPayload, "projection-started": parseProjectionPayload,
  "projection-applied": parseProjectionPayload, "projection-skipped-idempotent": parseProjectionPayload,
  "projection-failed": parseProjectionPayload, "recovery-required": parseProblemPayload,
  "recovery-resumed": parseExecutionPayload, "compensation-began": parseExecutionPayload,
  "compensation-started": parseCompensationPayload, "compensation-completed": parseCompensationPayload,
  "compensation-failed": parseCompensationPayload, succeeded: parseNonePayload,
  "succeeded-with-warnings": parseNonePayload, rejected: parseNonePayload,
  superseded: parseNonePayload, "approval-invalidated": parseProblemPayload,
  cancelled: parseNonePayload, compensated: parseNonePayload, failed: parseNonePayload,
  recovered: parseRecoveryPayload, abandoned: parseAbandonmentPayload,
  "notice-recorded": parseNoticePayload, "warning-recorded": parseWarningPayload,
};

/** Parse the exact payload grammar selected by the closed transition vocabulary. */
function parsePayload(type: OperationTransitionType, value: unknown): OperationTransitionPayload {
  return PAYLOAD_PARSERS[type](record(value, "transition payload"));
}

/** Parse the empty payload used by genesis and simple terminal edges. */
function parseNonePayload(obj: JsonRecord): OperationTransitionPayload {
  exact(obj, ["kind"]);
  if (obj.kind !== "none") throw new Error("transition payload kind mismatch");
  return { kind: "none" };
}

/** Parse the exact approval authority snapshot payload. */
function parseAuthorityPayload(obj: JsonRecord): OperationTransitionPayload {
  exact(obj, ["kind", "authoritySnapshotDigest"]);
  if (obj.kind !== "authority") throw new Error("transition payload kind mismatch");
  return { kind: "authority", authoritySnapshotDigest: digest(obj.authoritySnapshotDigest, "authority snapshot digest") };
}

/** Parse an authority snapshot plus the current executor owner. */
function parseExecutionPayload(obj: JsonRecord): OperationTransitionPayload {
  exact(obj, ["kind", "authoritySnapshotDigest", "applyOwner"]);
  if (obj.kind !== "execution") throw new Error("transition payload kind mismatch");
  return { kind: "execution", authoritySnapshotDigest: digest(obj.authoritySnapshotDigest, "authority snapshot digest"), applyOwner: parseApplyOwner(obj.applyOwner) };
}

/** Parse one closed operation problem code. */
function parseProblemPayload(obj: JsonRecord): OperationTransitionPayload {
  exact(obj, ["kind", "code"]);
  if (obj.kind !== "problem") throw new Error("transition payload kind mismatch");
  return { kind: "problem", code: enumValue(obj.code, OPERATION_PROBLEM_CODES, "operation problem code") };
}

/** Parse one manifest-bound mutation transition payload. */
function parseMutationPayload(obj: JsonRecord): OperationTransitionPayload {
  exact(obj, ["kind", "mutationId"], ["evidence", "detail"]);
  if (obj.kind !== "mutation") throw new Error("transition payload kind mismatch");
  const base: { kind: "mutation"; mutationId: MutationId; detail?: string } = { kind: "mutation", mutationId: mutationIdentity(obj.mutationId) };
  if (obj.detail !== undefined) base.detail = textValue(obj.detail, "mutation outcome detail", MAX_DETAIL_BYTES);
  return withEvidence(obj, base);
}

/** Parse one projection payload with immutable criticality metadata. */
function parseProjectionPayload(obj: JsonRecord): OperationTransitionPayload {
  exact(obj, ["kind", "mutationId", "criticality"], ["evidence"]);
  if (obj.kind !== "projection") throw new Error("transition payload kind mismatch");
  const base = { kind: "projection" as const, mutationId: mutationIdentity(obj.mutationId), criticality: enumValue(obj.criticality, ["required", "optional"] as const, "projection criticality") };
  return withEvidence(obj, base);
}

/** Parse one mutation-bound compensation payload. */
function parseCompensationPayload(obj: JsonRecord): OperationTransitionPayload {
  exact(obj, ["kind", "compensationId", "mutationId"], ["evidence"]);
  if (obj.kind !== "compensation") throw new Error("transition payload kind mismatch");
  const mutationId = mutationIdentity(obj.mutationId);
  const compensation = compensationIdentity(obj.compensationId);
  if (compensationId(mutationId) !== compensation) throw new Error("compensationId does not match mutationId");
  return withEvidence(obj, { kind: "compensation", compensationId: compensation, mutationId });
}

/** Parse one bounded informational notice code. */
function parseNoticePayload(obj: JsonRecord): OperationTransitionPayload {
  exact(obj, ["kind", "code"]);
  if (obj.kind !== "notice") throw new Error("transition payload kind mismatch");
  return { kind: "notice", code: textValue(obj.code, "notice code", MAX_CODE_BYTES) };
}

/** Parse one counted optional-work warning payload. */
function parseWarningPayload(obj: JsonRecord): OperationTransitionPayload {
  exact(obj, ["kind", "code", "attempted", "completed", "skipped", "failed"]);
  if (obj.kind !== "warning") throw new Error("transition payload kind mismatch");
  return { kind: "warning", ...parseWarningFields(obj) };
}

/** Parse the exact authenticated recovery-run terminal proof fields. */
function parseRecoveryPayload(obj: JsonRecord): OperationTransitionPayload {
  exact(obj, ["kind", "bundleId", "runId", "manifestDigest", "terminalState", "stateVersion", "chainTip"]);
  if (obj.kind !== "recovery") throw new Error("transition payload kind mismatch");
  const stateVersion = count(obj.stateVersion, "recovery stateVersion");
  if (stateVersion === 0) throw new Error("recovery stateVersion must be positive");
  return { kind: "recovery", bundleId: assertBundleId(obj.bundleId), runId: assertOperationRunId(obj.runId), manifestDigest: digest(obj.manifestDigest, "recovery manifest digest"), terminalState: enumValue(obj.terminalState, ["succeeded", "succeeded-with-warnings", "compensated"] as const, "recovery terminal state"), stateVersion, chainTip: digest(obj.chainTip, "recovery chain tip") };
}

/** Parse explicit residual-state confirmation and its compact finding binding. */
function parseAbandonmentPayload(obj: JsonRecord): OperationTransitionPayload {
  exact(obj, ["kind", "confirmation", "findingCount", "findingsDigest"]);
  if (obj.kind !== "abandonment" || obj.confirmation !== "confirm-residual-state") {
    throw new Error("abandonment confirmation mismatch");
  }
  const findingCount = count(obj.findingCount, "abandonment findingCount");
  if (findingCount > MAX_MUTATIONS_PER_BUNDLE) throw new Error("abandonment findings exceed launch bounds");
  return {
    kind: "abandonment", confirmation: "confirm-residual-state", findingCount,
    findingsDigest: digest(obj.findingsDigest, "abandonment findings digest"),
  };
}

/** Attach one optional exact evidence reference to a parsed payload. */
type EvidencePayload = Extract<OperationTransitionPayload, { kind: "mutation" | "projection" | "compensation" }>;

/** Attach one optional rebuilt out-of-line evidence reference. */
function withEvidence(obj: JsonRecord, base: EvidencePayload): EvidencePayload {
  const evidence = obj.evidence === undefined ? undefined : parseTransitionEvidence(obj.evidence);
  return { ...base, ...(evidence === undefined ? {} : { evidence }) };
}

/** Parse one exact bounded run-evidence reference. */
function parseTransitionEvidence(value: unknown): OperationEvidenceReference {
  const obj = record(value, "evidence reference");
  if (obj.kind === "evidence-over-limit") return parseOverLimitEvidence(obj);
  return parseStoredEvidenceRecord(obj);
}

/** Parse evidence that must correspond to a retained evidence-store blob. */
function parseStoredEvidence(value: unknown): RunEvidenceRef {
  return parseStoredEvidenceRecord(record(value, "evidence reference"));
}

/** Rebuild the exact normal evidence-reference fields. */
function parseStoredEvidenceRecord(obj: JsonRecord): RunEvidenceRef {
  exact(obj, ["digest", "byteCount", "type", "provenance"]);
  const byteCount = count(obj.byteCount, "evidence byteCount");
  if (byteCount > MAX_RUN_EVIDENCE_BLOB_BYTES) throw new Error("evidence reference exceeds blob cap");
  return { digest: digest(obj.digest, "evidence digest"), byteCount, type: textValue(obj.type, "evidence type", MAX_CODE_BYTES), provenance: textValue(obj.provenance, "evidence provenance", MAX_CODE_BYTES) };
}

/** Parse evidence omitted from blob custody because it exceeded the cap. */
function parseOverLimitEvidence(obj: JsonRecord): OperationEvidenceReference {
  exact(obj, ["kind", "digest", "byteCount", "type", "provenance", "excerpt"]);
  const byteCount = count(obj.byteCount, "over-limit evidence byteCount");
  if (byteCount <= MAX_RUN_EVIDENCE_BLOB_BYTES) {
    throw new Error("over-limit evidence does not exceed the blob cap");
  }
  return {
    kind: "evidence-over-limit", digest: digest(obj.digest, "over-limit evidence digest"),
    byteCount, type: textValue(obj.type, "evidence type", MAX_CODE_BYTES),
    provenance: textValue(obj.provenance, "evidence provenance", MAX_CODE_BYTES),
    excerpt: textValue(obj.excerpt, "over-limit evidence excerpt", 256),
  };
}

/** Parse one canonical mutation identity without deriving a new one. */
function mutationIdentity(value: unknown): MutationId {
  if (typeof value !== "string" || !MUTATION_ID.test(value)) throw new Error("invalid mutationId");
  return value as MutationId;
}

/** Parse one canonical compensation identity. */
function compensationIdentity(value: unknown): CompensationId {
  if (typeof value !== "string" || !COMPENSATION_ID.test(value)) throw new Error("invalid compensationId");
  return value as CompensationId;
}

/** Parse one member of the closed run-state vocabulary. */
function state(value: unknown): OperationRunState {
  return enumValue(value, OPERATION_RUN_STATES, "operation run state") as OperationRunState;
}

/** Parse bounded current authoritative-mutation outcomes. */
function parseMutationOutcomes(value: unknown): MutationOutcome[] {
  return array(value, "mutationOutcomes", MAX_MUTATIONS_PER_BUNDLE).map((item) => {
    const obj = record(item, "mutation outcome"); exact(obj, ["mutationId", "status", "transitionSequence"], ["detail"]);
    return { mutationId: mutationIdentity(obj.mutationId), status: enumValue(obj.status, ["started", "applied", "skipped-idempotent", "failed"] as const, "mutation outcome"), transitionSequence: count(obj.transitionSequence, "transitionSequence"), ...(obj.detail === undefined ? {} : { detail: textValue(obj.detail, "mutation outcome detail", MAX_DETAIL_BYTES) }) };
  });
}

/** Parse bounded current compensation outcomes. */
function parseCompensationOutcomes(value: unknown): CompensationOutcome[] {
  return array(value, "compensationOutcomes", MAX_MUTATIONS_PER_BUNDLE).map((item) => {
    const obj = record(item, "compensation outcome"); exact(obj, ["compensationId", "mutationId", "status", "transitionSequence"]);
    const mutationId = mutationIdentity(obj.mutationId), compensation = compensationIdentity(obj.compensationId);
    if (compensationId(mutationId) !== compensation) throw new Error("compensation outcome identity mismatch");
    return { compensationId: compensation, mutationId, status: enumValue(obj.status, ["started", "completed", "failed"] as const, "compensation outcome"), transitionSequence: count(obj.transitionSequence, "transitionSequence") };
  });
}

/** Parse bounded current projection outcomes. */
function parseProjectionOutcomes(value: unknown): ProjectionOutcome[] {
  return array(value, "projectionOutcomes", MAX_MUTATIONS_PER_BUNDLE).map((item) => {
    const obj = record(item, "projection outcome"); exact(obj, ["mutationId", "criticality", "status", "transitionSequence"]);
    return { mutationId: mutationIdentity(obj.mutationId), criticality: enumValue(obj.criticality, ["required", "optional"] as const, "projection criticality"), status: enumValue(obj.status, ["started", "applied", "skipped-idempotent", "failed"] as const, "projection outcome"), transitionSequence: count(obj.transitionSequence, "transitionSequence") };
  });
}

/** Parse the complete duplicated status-counter projection. */
function parseCounters(value: unknown): OperationRunCounters {
  const obj = record(value, "counters"); exact(obj, ["mutations", "compensations", "projections"]);
  return { mutations: parseMutationCounters(obj.mutations, "mutation counters"), compensations: parseCompensationCounters(obj.compensations), projections: parseMutationCounters(obj.projections, "projection counters") };
}

/** Parse mutation-shaped attempted/applied/skipped/failed counters. */
function parseMutationCounters(value: unknown, label: string) {
  const obj = record(value, label); exact(obj, ["attempted", "applied", "skipped", "failed"]);
  return { attempted: count(obj.attempted, `${label} attempted`), applied: count(obj.applied, `${label} applied`), skipped: count(obj.skipped, `${label} skipped`), failed: count(obj.failed, `${label} failed`) };
}

/** Parse compensation attempted/completed/failed counters. */
function parseCompensationCounters(value: unknown) {
  const obj = record(value, "compensation counters"); exact(obj, ["attempted", "completed", "failed"]);
  return { attempted: count(obj.attempted, "compensation attempted"), completed: count(obj.completed, "compensation completed"), failed: count(obj.failed, "compensation failed") };
}

/** Parse one top-level completion-warning projection. */
function parseWarning(value: unknown) {
  const obj = record(value, "completion warning"); exact(obj, ["code", "attempted", "completed", "skipped", "failed"]);
  return parseWarningFields(obj);
}

/** Parse and reconcile the warning counters shared by payload and projection. */
function parseWarningFields(obj: JsonRecord) {
  return warningFields(obj, MAX_CODE_BYTES);
}

/** Parse one top-level informational notice projection. */
function parseNotice(value: unknown) {
  const obj = record(value, "notice"); exact(obj, ["code"]);
  return { code: textValue(obj.code, "notice code", MAX_CODE_BYTES) };
}

/** Parse one bounded permanent residual observation. */
function parseResidual(value: unknown) {
  const obj = record(value, "residual finding"); exact(obj, ["code"], ["mutationId", "authoritativeNamespace", "evidence"]);
  const mutationId = obj.mutationId === undefined ? undefined : mutationIdentity(obj.mutationId);
  const namespace = obj.authoritativeNamespace === undefined ? undefined : textValue(obj.authoritativeNamespace, "authoritative namespace", MAX_CODE_BYTES);
  const evidence = obj.evidence === undefined ? undefined : parseStoredEvidence(obj.evidence);
  return { code: textValue(obj.code, "residual code", MAX_CODE_BYTES), ...(mutationId === undefined ? {} : { mutationId }), ...(namespace === undefined ? {} : { authoritativeNamespace: namespace }), ...(evidence === undefined ? {} : { evidence }) };
}

/** Parse the active executor process identity. */
function parseApplyOwner(value: unknown) {
  const obj = record(value, "applyOwner"); exact(obj, ["pid", "processStartTime"]);
  const pid = count(obj.pid, "applyOwner pid");
  if (pid === 0) throw new Error("applyOwner pid must be positive");
  return { pid, processStartTime: textValue(obj.processStartTime, "processStartTime", MAX_CODE_BYTES) };
}
