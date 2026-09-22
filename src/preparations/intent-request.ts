/**
 * @file src/preparations/intent-request.ts
 * @description Capture and AUTHENTICATE everything one intent compilation reads.
 * Task 7's evidence types are structural and unbranded, so a caller could hand
 * the compiler records SHAPED like settled host authority that no host authority
 * ever authored — and `needs-operator` would be advisory at the only place that
 * acts on it. Two disciplines close that. Every container is captured through the
 * canonical dense-array primitive, so an array-like carrying its own
 * `filter`/`map` cannot decide what the compiler sees. Every record is then
 * re-authenticated against its OWN recomputed digest — proposal identity,
 * reconciliation policy binding, selection binding, completeness deficits —
 * before the compiler reads a single field. Authenticate, never trust.
 */

import { captureDenseArray, captureOwnDataRecord } from "../utils/runtime-capture.js";
import type { OperationAdapterMap } from "../operation-bundles/adapter-registry.js";
import type { OperationMutation } from "../operation-bundles/types.js";
import type { BundleId } from "../operation-bundles/ids.js";
import { assertCompletenessPermitsSuccess, type PreparationCompletenessV1 } from "./completeness.js";
import { assertProposalAuthentic, type PreparationProposalV1 } from "./proposals.js";
import {
  assertDeferPermitted, assertReconciliationAuthentic, assertReconciliationsSettled,
  pendingOperatorReconciliations, type PreparationReconciliationV1,
} from "./reconciliation.js";
import {
  assertCapturedPolicyContract, assertSelectionDecisionAuthentic,
  type PreparationPolicyContractV1, type SelectionDecisionV1,
} from "./selection.js";
import type { GateProofSummaryV1 } from "./run-types.js";
import type { Sha256Digest } from "./types.js";

/** Distribute `Omit` across a union so each member keeps its own literal shape. */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** The envelope fields the compiler STAMPS; a draft may never supply them. */
export const ENVELOPE_KEYS = Object.freeze([
  "index", "mutationId", "dependsOn", "reconciliationRefs",
] as const);

const MAX_REQUEST_RECORDS = 1_024;
const TARGET_KEYS = Object.freeze(["logicalIdentity", "draft"] as const);
const OPTIONAL_TARGET_KEYS = Object.freeze(["dependsOnLogicalIdentities"] as const);
const SETTLEMENT_KEYS = Object.freeze([
  "gateProofs", "gateId", "currentPlanDigest", "phaseDigest", "authorityDigest",
] as const);
const OPTIONAL_SETTLEMENT_KEYS = Object.freeze(["effectDigest"] as const);
const REQUEST_KEYS = Object.freeze([
  "bundleId", "adapters", "contract", "targets", "proposals",
  "reconciliations", "selections", "completeness",
] as const);
const OPTIONAL_REQUEST_KEYS = Object.freeze(["requiredProposalIds", "settlement"] as const);

/** Closed reason intent compilation failed closed. */
export type IntentCompilerCode =
  | "invalid-draft" | "envelope-field-supplied" | "unknown-mutation-kind" | "unresolved-target"
  | "duplicate-target" | "unknown-dependency" | "needs-operator-pending" | "required-deficit"
  | "missing-target-identity" | "unknown-proposal" | "mutation-cap-exceeded"
  | "invalid-request" | "unauthenticated-evidence" | "defer-not-permitted"
  | "missing-required-authority" | "self-dependency" | "forward-dependency";

/** Typed refusal raised for every intent-compilation failure. */
export class IntentCompilerError extends Error {
  readonly code: IntentCompilerCode;
  constructor(code: IntentCompilerCode, options?: { cause?: unknown }) {
    super(`preparation intent compiler: ${code}`, options);
    this.name = "IntentCompilerError";
    this.code = code;
  }
}

/** The host's authoritative mutation body for one LOGICAL target identity. */
export interface HostMutationTargetV1 {
  readonly logicalIdentity: string;
  readonly draft: DistributiveOmit<OperationMutation, (typeof ENVELOPE_KEYS)[number]>;
  readonly dependsOnLogicalIdentities?: readonly string[];
}

/**
 * The operator-gate settlement authority a pending `needs-operator` reconciliation
 * is closed by. It carries ONLY the operator gate proof and the dimensions it is
 * revalidated on; it is deliberately NOT the source of which output is required
 * (that host authority lives on {@link IntentCompilationRequestV1.requiredProposalIds}),
 * so an omitted settlement can never be read as "no output is required".
 */
export interface IntentSettlementV1 {
  readonly gateProofs: readonly GateProofSummaryV1[];
  readonly gateId: string;
  readonly currentPlanDigest: Sha256Digest;
  readonly phaseDigest: Sha256Digest;
  readonly authorityDigest: Sha256Digest;
  readonly effectDigest?: Sha256Digest;
}

/**
 * Everything one compilation reads; all of it immutable or host-authoritative.
 * `requiredProposalIds` is the HOST's required-output declaration — the authority
 * that decides whether a `defer` abandons required output. It is independent of
 * the optional operator {@link settlement}: when any reconciliation defers, this
 * declaration MUST be present (an explicit, possibly empty array), because its
 * absence is a refusal rather than an empty "nothing is required" set.
 */
export interface IntentCompilationRequestV1 {
  readonly bundleId: BundleId;
  readonly adapters: OperationAdapterMap;
  readonly contract: PreparationPolicyContractV1;
  readonly targets: readonly HostMutationTargetV1[];
  readonly proposals: readonly PreparationProposalV1[];
  readonly reconciliations: readonly PreparationReconciliationV1[];
  readonly selections: readonly SelectionDecisionV1[];
  readonly completeness: PreparationCompletenessV1;
  readonly requiredProposalIds?: readonly string[];
  readonly settlement?: IntentSettlementV1;
}

/** One host target captured into data-only form before anything reads it. */
export interface CapturedTargetV1 {
  readonly logicalIdentity: string;
  readonly draft: unknown;
  readonly dependsOnLogicalIdentities: readonly string[];
}

/** The captured, authenticated request the compiler actually reads. */
export interface CapturedIntentRequestV1 {
  readonly bundleId: BundleId;
  readonly adapters: OperationAdapterMap;
  readonly contract: PreparationPolicyContractV1;
  readonly targets: readonly CapturedTargetV1[];
  readonly proposals: readonly PreparationProposalV1[];
  readonly reconciliations: readonly PreparationReconciliationV1[];
  readonly selections: readonly SelectionDecisionV1[];
  readonly completeness: PreparationCompletenessV1;
}

/** Capture one record against a closed required/optional key allowlist. */
function captureAllowlisted(
  value: unknown, required: readonly string[], optional: readonly string[],
): Readonly<Record<string, unknown>> {
  let record: Readonly<Record<string, unknown>>;
  try {
    record = captureOwnDataRecord(value);
  } catch (cause) {
    throw new IntentCompilerError("invalid-request", { cause });
  }
  const allowed = new Set<string>([...required, ...optional]);
  if (required.some((key) => record[key] === undefined)
    || Object.keys(record).some((key) => !allowed.has(key))) {
    throw new IntentCompilerError("invalid-request");
  }
  return record;
}

/** Capture one bounded container, translating every failure into a refusal. */
function captureRecords<T>(
  value: unknown, capture: (item: unknown) => T, code: IntentCompilerCode,
): readonly T[] {
  try {
    return captureDenseArray(value, MAX_REQUEST_RECORDS, capture,
      () => new IntentCompilerError("invalid-request"));
  } catch (cause) {
    throw cause instanceof IntentCompilerError ? cause : new IntentCompilerError(code, { cause });
  }
}

/** Capture one host target, including its dependency container. */
function captureTarget(value: unknown): CapturedTargetV1 {
  const record = captureAllowlisted(value, TARGET_KEYS, OPTIONAL_TARGET_KEYS);
  const dependsOn = record.dependsOnLogicalIdentities;
  return Object.freeze({
    logicalIdentity: requireIdentity(record.logicalIdentity),
    draft: record.draft,
    dependsOnLogicalIdentities: dependsOn === undefined
      ? Object.freeze([])
      : captureRecords(dependsOn, requireIdentity, "invalid-request"),
  });
}

/** Require one non-empty logical identity string. */
function requireIdentity(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new IntentCompilerError("invalid-request");
  return value;
}

/**
 * Capture and authenticate one compilation request. Nothing downstream reads the
 * caller's objects again: the compiler is handed this copy and only this copy.
 */
export function captureIntentRequest(request: IntentCompilationRequestV1): CapturedIntentRequestV1 {
  const record = captureAllowlisted(request, REQUEST_KEYS, OPTIONAL_REQUEST_KEYS);
  const contract = authenticate(() => assertCapturedPolicyContract(record.contract));
  const reconciliations = captureRecords(record.reconciliations,
    (item) => authenticate(() => assertReconciliationAuthentic(item, contract)), "unauthenticated-evidence");
  assertSettled(reconciliations, record.settlement);
  assertDeferAuthority(reconciliations, record.requiredProposalIds);
  return Object.freeze({
    bundleId: record.bundleId as BundleId,
    adapters: record.adapters as OperationAdapterMap,
    contract,
    targets: captureRecords(record.targets, captureTarget, "invalid-request"),
    proposals: captureRecords(record.proposals,
      (item) => authenticate(() => assertProposalAuthentic(item)), "unauthenticated-evidence"),
    reconciliations,
    selections: captureRecords(record.selections,
      (item) => authenticate(() => assertSelectionDecisionAuthentic(item)), "unauthenticated-evidence"),
    completeness: authenticateCompleteness(record.completeness),
  });
}

/** Run one authenticity check, re-typing its refusal as a compilation refusal. */
function authenticate<T>(check: () => T): T {
  try {
    return check();
  } catch (cause) {
    throw new IntentCompilerError("unauthenticated-evidence", { cause });
  }
}

/** Refuse a completeness record whose stored deficits it cannot itself derive. */
function authenticateCompleteness(value: unknown): PreparationCompletenessV1 {
  const record = value as PreparationCompletenessV1;
  try {
    assertCompletenessPermitsSuccess(record);
  } catch (cause) {
    throw new IntentCompilerError("required-deficit", { cause });
  }
  return record;
}

/**
 * Enforce the operator-gate settlement the reconciliation module owns but nothing
 * in `src/` previously called. A pending `needs-operator` obligation with no
 * settlement authority is refused outright; with one, the approved gate proof
 * must still be current on every bound dimension. The OPTIONAL settlement carries
 * ONLY this operator authority — whether a `defer` abandons required output is a
 * separate HOST-sourced question, decided in {@link assertDeferAuthority}.
 */
function assertSettled(
  reconciliations: readonly PreparationReconciliationV1[], value: unknown,
): void {
  const settlement = value === undefined
    ? undefined : captureAllowlisted(value, SETTLEMENT_KEYS, OPTIONAL_SETTLEMENT_KEYS);
  const pending = pendingOperatorReconciliations(reconciliations);
  if (pending.length === 0) return;
  if (settlement === undefined) throw new IntentCompilerError("needs-operator-pending");
  try {
    assertReconciliationsSettled({
      records: reconciliations,
      gateProofs: settlement.gateProofs as readonly GateProofSummaryV1[],
      gateId: settlement.gateId as string,
      currentPlanDigest: settlement.currentPlanDigest as Sha256Digest,
      phaseDigest: settlement.phaseDigest as Sha256Digest,
      authorityDigest: settlement.authorityDigest as Sha256Digest,
      ...(settlement.effectDigest === undefined
        ? {} : { effectDigest: settlement.effectDigest as Sha256Digest }),
    });
  } catch (cause) {
    throw new IntentCompilerError("needs-operator-pending", { cause });
  }
}

/**
 * Refuse to compile a `defer` that stands in for required output. The required
 * set is HOST authority read straight from the request, and it is NEVER
 * defaulted: when any reconciliation defers, an explicit required-output
 * declaration MUST be present, so an omitted declaration is a refusal rather than
 * an empty "nothing is required" set — omission can never launder a required
 * proposal into a silent deferral. An explicit (possibly empty) declaration is
 * consulted through the reconciliation module's own gate; the optional operator
 * settlement has no say here.
 */
function assertDeferAuthority(
  reconciliations: readonly PreparationReconciliationV1[], requiredProposalIds: unknown,
): void {
  if (!reconciliations.some((record) => record.decision === "defer")) return;
  if (requiredProposalIds === undefined) throw new IntentCompilerError("missing-required-authority");
  try {
    assertDeferPermitted({
      records: reconciliations, requiredProposalIds: requiredProposalIds as readonly string[],
    });
  } catch (cause) {
    throw new IntentCompilerError("defer-not-permitted", { cause });
  }
}
