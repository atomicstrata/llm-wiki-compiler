/**
 * @file src/preparations/reconciliation.ts
 * @description Host-authored reconciliation of conflicting or overlapping
 * proposals (design section 21.2). The decision comes from a CLOSED six-value
 * vocabulary, the reason codes come from a REGISTERED host-handler contract, and
 * the policy digest is recomputed from the contract and decision rather than
 * accepted from a caller. `needs-operator` is not advisory: it BECOMES A GATE —
 * settlement requires an approved gate proof bound, through the landed
 * gate-revalidation primitive, to the EXACT pending reconciliation set, so a
 * proof approved for some other set (or for a superseded plan) never settles it.
 * `defer` may not silently satisfy required output either.
 */

import { canonicalDigest } from "../profile/templates/signing/canonical.js";
import { parseSha256Digest } from "../capability-providers/ids.js";
import { captureDenseArray, captureOwnDataRecord, deepCaptureData } from "../utils/runtime-capture.js";
import { captureEvidenceRefs } from "./evidence-capture.js";
import { findApprovedGateProof, revalidateApprovedGateProof } from "./gates.js";
import { assertSafeComponent } from "./ids.js";
import {
  assertCapturedPolicyContract, policyContractDigest, type PreparationPolicyContractV1,
} from "./selection.js";
import type { PreparationProposalV1 } from "./proposals.js";
import type { GateProofSummaryV1 } from "./run-types.js";
import type { ReconciliationResolution } from "../operation-bundles/types.js";
import type { EvidenceRefV1, Sha256Digest } from "./types.js";

/** The SIX and only reconciliation decisions (design section 21.2). */
export const RECONCILIATION_DECISIONS = Object.freeze([
  "accept", "reject", "merge", "supersede", "defer", "needs-operator",
] as const);

export type PreparationReconciliationDecision = (typeof RECONCILIATION_DECISIONS)[number];

/**
 * The closed mapping from a settled host decision to Milestone A's closed
 * reconciliation resolution. `defer` and `needs-operator` map to nothing: they
 * are unsettled and cannot enter a bundle at all. The table is PROTOTYPE-LESS,
 * so a lookup can never reach an inherited `Object.prototype` member: a forged
 * decision named `toString` or `constructor` must not be able to leak a function
 * into a compiled Milestone A resolution. Read it through
 * {@link resolutionForDecision}, never by bare index.
 */
export const RESOLUTION_BY_DECISION: Readonly<
  Partial<Record<PreparationReconciliationDecision, ReconciliationResolution>>
> = Object.freeze(Object.assign(
  Object.create(null) as Partial<Record<PreparationReconciliationDecision, ReconciliationResolution>>,
  {
    accept: "create-distinct", merge: "merge-evidence",
    supersede: "supersede-candidate", reject: "reject-candidate",
  } as const,
));

/**
 * Resolve one decision to its Milestone A resolution through EXPLICIT closed
 * membership: the decision must appear in {@link RECONCILIATION_DECISIONS} and
 * the table must OWN the key. An unsettled decision returns `undefined`; anything
 * outside the closed vocabulary is a refusal, never an inherited member.
 */
export function resolutionForDecision(decision: unknown): ReconciliationResolution | undefined {
  if (typeof decision !== "string" || !(RECONCILIATION_DECISIONS as readonly string[]).includes(decision)) {
    throw new ReconciliationAuthorityError("invalid-decision");
  }
  return Object.hasOwn(RESOLUTION_BY_DECISION, decision)
    ? RESOLUTION_BY_DECISION[decision as PreparationReconciliationDecision]
    : undefined;
}

/** The decisions that may carry a host-computed result digest. */
const RESOLVING_DECISIONS = Object.freeze(["accept", "merge", "supersede"] as const);

const DECIDE_INPUT_KEYS = Object.freeze([
  "reconciliationId", "contract", "proposals", "proposalIds", "decision", "reasonCodes", "evidenceRefs",
] as const);
const OPTIONAL_DECIDE_INPUT_KEYS = Object.freeze(["resultDigest"] as const);

const MAX_PROPOSAL_REFS = 256;
const MAX_REASON_CODES = 16;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const POLICY_DOMAIN = "llmwiki-preparation-reconciliation-policy-v1";
const SET_DOMAIN = "llmwiki-preparation-reconciliation-set-v1";

/** Closed reason a reconciliation decision or settlement failed closed. */
export type ReconciliationCode =
  | "invalid-reconciliation" | "invalid-decision" | "unknown-proposal" | "duplicate-proposal"
  | "missing-reason-code" | "unknown-reason-code" | "result-not-resolved"
  | "needs-operator-gate-missing" | "defer-not-optional";

/** Typed refusal raised for every reconciliation authority failure. */
export class ReconciliationAuthorityError extends Error {
  readonly code: ReconciliationCode;
  constructor(code: ReconciliationCode) {
    super(`preparation reconciliation authority: ${code}`);
    this.name = "ReconciliationAuthorityError";
    this.code = code;
  }
}

/** One host-authored reconciliation decision (design section 21.2). */
export interface PreparationReconciliationV1 {
  readonly schemaVersion: 1;
  readonly reconciliationId: string;
  readonly proposalIds: readonly string[];
  readonly decision: PreparationReconciliationDecision;
  readonly policyDigest: Sha256Digest;
  readonly resultDigest?: Sha256Digest;
  readonly reasonCodes: readonly string[];
  readonly evidenceRefs: readonly EvidenceRefV1[];
}

/** The host inputs one reconciliation decision is authored from. */
export interface ReconciliationDecideInputV1 {
  readonly reconciliationId: string;
  readonly contract: PreparationPolicyContractV1;
  readonly proposals: readonly PreparationProposalV1[];
  readonly proposalIds: readonly string[];
  readonly decision: PreparationReconciliationDecision;
  readonly reasonCodes: readonly string[];
  readonly evidenceRefs: readonly EvidenceRefV1[];
  readonly resultDigest?: Sha256Digest;
}

/** Capture the decide input against the closed key allowlist before any use. */
function captureDecideInput(input: ReconciliationDecideInputV1): Readonly<Record<string, unknown>> {
  let record: Readonly<Record<string, unknown>>;
  try {
    record = captureOwnDataRecord(input);
  } catch {
    throw new ReconciliationAuthorityError("invalid-reconciliation");
  }
  const allowed = new Set<string>([...DECIDE_INPUT_KEYS, ...OPTIONAL_DECIDE_INPUT_KEYS]);
  if (DECIDE_INPUT_KEYS.some((key) => record[key] === undefined)
    || Object.keys(record).some((key) => !allowed.has(key))) {
    throw new ReconciliationAuthorityError("invalid-reconciliation");
  }
  return record;
}

/** Validate one safe identity component, refusing with this module's code. */
function safeComponent(value: unknown): string {
  try {
    return assertSafeComponent(value);
  } catch {
    throw new ReconciliationAuthorityError("invalid-reconciliation");
  }
}

/**
 * Capture one bounded list of grammar-checked identity strings. Every id, code,
 * and reference list in this module funnels through this ONE primitive, so a
 * container can never be read by a weaker path than its siblings.
 */
function captureIdentityList(
  value: unknown, maximum: number, invalid: ReconciliationCode,
): readonly string[] {
  try {
    return captureDenseArray(value, maximum, (item) => {
      if (typeof item !== "string" || !IDENTITY_PATTERN.test(item)) {
        throw new ReconciliationAuthorityError(invalid);
      }
      return item;
    }, () => new ReconciliationAuthorityError("invalid-reconciliation"));
  } catch (error) {
    throw error instanceof ReconciliationAuthorityError
      ? error : new ReconciliationAuthorityError("invalid-reconciliation");
  }
}

/** Capture one bounded, non-empty, duplicate-free list of proposal ids. */
function captureProposalIdList(value: unknown): readonly string[] {
  const ids = captureIdentityList(value, MAX_PROPOSAL_REFS, "invalid-reconciliation");
  if (ids.length === 0) throw new ReconciliationAuthorityError("invalid-reconciliation");
  if (new Set(ids).size !== ids.length) throw new ReconciliationAuthorityError("duplicate-proposal");
  return ids;
}

/** Capture the SETTLED proposal set's host identities from its own container. */
function captureSettledProposalIds(value: unknown): ReadonlySet<string> {
  let ids: readonly string[];
  try {
    ids = captureDenseArray(value, MAX_PROPOSAL_REFS, (item) => {
      const proposal = captureOwnDataRecord(item);
      if (typeof proposal.proposalId !== "string") {
        throw new ReconciliationAuthorityError("invalid-reconciliation");
      }
      return proposal.proposalId;
    }, () => new ReconciliationAuthorityError("invalid-reconciliation"));
  } catch (error) {
    throw error instanceof ReconciliationAuthorityError
      ? error : new ReconciliationAuthorityError("invalid-reconciliation");
  }
  return new Set(ids);
}

/** Bind the referenced proposal ids to the SETTLED proposal set, in order. */
function captureProposalIds(value: unknown, proposals: unknown): readonly string[] {
  const ids = captureProposalIdList(value);
  const settled = captureSettledProposalIds(proposals);
  if (ids.some((id) => !settled.has(id))) throw new ReconciliationAuthorityError("unknown-proposal");
  return ids;
}

/** Close the reason codes to the registered contract's vocabulary. */
function captureReasonCodes(
  value: unknown, contract: PreparationPolicyContractV1,
): readonly string[] {
  const permitted = new Set(contract.reconciliationReasonCodes);
  let codes: readonly string[];
  try {
    codes = captureDenseArray(value, MAX_REASON_CODES, (item) => {
      if (typeof item !== "string" || !permitted.has(item)) {
        throw new ReconciliationAuthorityError("unknown-reason-code");
      }
      return item;
    }, () => new ReconciliationAuthorityError("invalid-reconciliation"));
  } catch (error) {
    throw error instanceof ReconciliationAuthorityError
      ? error : new ReconciliationAuthorityError("invalid-reconciliation");
  }
  if (codes.length === 0) throw new ReconciliationAuthorityError("missing-reason-code");
  return codes;
}

/**
 * Author one host-owned reconciliation decision. The policy digest is
 * RECOMPUTED from the registered contract and the decision, so a caller cannot
 * present a decision as governed by a policy it was not made under.
 */
export function decideReconciliation(input: ReconciliationDecideInputV1): PreparationReconciliationV1 {
  const record = captureDecideInput(input);
  if (!(RECONCILIATION_DECISIONS as readonly string[]).includes(record.decision as string)) {
    throw new ReconciliationAuthorityError("invalid-decision");
  }
  const decision = record.decision as PreparationReconciliationDecision;
  const contract = assertCapturedPolicyContract(record.contract);
  const proposalIds = captureProposalIds(record.proposalIds, record.proposals);
  const reasonCodes = captureReasonCodes(record.reasonCodes, contract);
  if (record.resultDigest !== undefined
    && !(RESOLVING_DECISIONS as readonly string[]).includes(decision)) {
    throw new ReconciliationAuthorityError("result-not-resolved");
  }
  return Object.freeze({
    schemaVersion: 1 as const, reconciliationId: safeComponent(record.reconciliationId), proposalIds, decision,
    policyDigest: reconciliationPolicyDigest(contract, decision, reasonCodes),
    ...(record.resultDigest === undefined ? {} : { resultDigest: parseSha256Digest(record.resultDigest) }),
    reasonCodes, evidenceRefs: captureEvidenceRefs(record.evidenceRefs),
  });
}

/**
 * Recompute the policy binding of one decision from the REGISTERED contract, the
 * decision, and its canonical reason codes. Author and consumer call this exact
 * function, so a record that never passed {@link decideReconciliation} cannot
 * present a policy digest that matches.
 */
export function reconciliationPolicyDigest(
  contract: PreparationPolicyContractV1,
  decision: PreparationReconciliationDecision,
  reasonCodes: readonly string[],
): Sha256Digest {
  return parseSha256Digest(canonicalDigest({
    domain: POLICY_DOMAIN, contract: policyContractDigest(contract),
    decision, reasonCodes: [...reasonCodes].sort(),
  }));
}

/** Every field one complete reconciliation record carries. */
const RECONCILIATION_KEYS = Object.freeze([
  "schemaVersion", "reconciliationId", "proposalIds", "decision",
  "policyDigest", "resultDigest", "reasonCodes", "evidenceRefs",
] as const);
const OPTIONAL_RECONCILIATION_KEYS = Object.freeze(["resultDigest"] as const);

/**
 * Authenticate one reconciliation at a CONSUMER. `PreparationReconciliationV1`
 * is structural and unbranded, so a hand-built record could otherwise present
 * itself as settled host authority — which is exactly what makes `needs-operator`
 * advisory. The reason codes are re-closed to the registered contract and
 * `policyDigest` is RECOMPUTED through {@link reconciliationPolicyDigest}; a
 * record that does not match is refused.
 */
export function assertReconciliationAuthentic(
  value: unknown, contract: PreparationPolicyContractV1,
): PreparationReconciliationV1 {
  let record: Readonly<Record<string, unknown>>;
  try {
    record = captureOwnDataRecord(deepCaptureData(value));
  } catch {
    throw new ReconciliationAuthorityError("invalid-reconciliation");
  }
  const allowed = new Set<string>(RECONCILIATION_KEYS);
  const optional = new Set<string>(OPTIONAL_RECONCILIATION_KEYS);
  if (Object.keys(record).some((key) => !allowed.has(key))
    || RECONCILIATION_KEYS.some((key) => record[key] === undefined && !optional.has(key))) {
    throw new ReconciliationAuthorityError("invalid-reconciliation");
  }
  return buildAuthenticReconciliation(record, contract);
}

/** Rebuild one authenticated reconciliation, refusing a mismatched binding. */
function buildAuthenticReconciliation(
  record: Readonly<Record<string, unknown>>, contract: PreparationPolicyContractV1,
): PreparationReconciliationV1 {
  if (!(RECONCILIATION_DECISIONS as readonly string[]).includes(record.decision as string)
    || record.schemaVersion !== 1) {
    throw new ReconciliationAuthorityError("invalid-decision");
  }
  const decision = record.decision as PreparationReconciliationDecision;
  const reasonCodes = captureReasonCodes(record.reasonCodes, contract);
  if (record.policyDigest !== reconciliationPolicyDigest(contract, decision, reasonCodes)) {
    throw new ReconciliationAuthorityError("invalid-reconciliation");
  }
  return Object.freeze({
    schemaVersion: 1 as const, reconciliationId: safeComponent(record.reconciliationId),
    proposalIds: captureProposalIdList(record.proposalIds), decision,
    policyDigest: parseSha256Digest(record.policyDigest),
    ...(record.resultDigest === undefined ? {} : { resultDigest: parseSha256Digest(record.resultDigest) }),
    reasonCodes, evidenceRefs: captureEvidenceRefs(record.evidenceRefs),
  });
}

/** Capture one bounded reconciliation container by own numeric descriptors. */
function captureReconciliationList(
  value: unknown,
): readonly PreparationReconciliationV1[] {
  try {
    return captureDenseArray(value, MAX_PROPOSAL_REFS,
      (item) => captureOwnDataRecord(item) as unknown as PreparationReconciliationV1,
      () => new ReconciliationAuthorityError("invalid-reconciliation"));
  } catch (error) {
    throw error instanceof ReconciliationAuthorityError
      ? error : new ReconciliationAuthorityError("invalid-reconciliation");
  }
}

/**
 * Every reconciliation still waiting on an operator gate decision. The container
 * is CAPTURED first: an array-like carrying its own `filter` would otherwise
 * decide for the host how many obligations are pending.
 */
export function pendingOperatorReconciliations(
  records: readonly PreparationReconciliationV1[],
): readonly PreparationReconciliationV1[] {
  return Object.freeze(
    captureReconciliationList(records).filter((record) => record.decision === "needs-operator"));
}

/**
 * The canonical digest of the EXACT pending operator obligations. The gate proof
 * that settles them must be bound to this digest, so approving one set can never
 * settle a different — or a later, larger — set.
 */
export function reconciliationSetDigest(
  records: readonly PreparationReconciliationV1[],
): Sha256Digest {
  const pending = pendingOperatorReconciliations(records).map((record) => ({
    reconciliationId: safeComponent(record.reconciliationId),
    proposalIds: captureProposalIdList(record.proposalIds),
    policyDigest: parseSha256Digest(record.policyDigest),
    reasonCodes: captureIdentityList(record.reasonCodes, MAX_REASON_CODES, "unknown-reason-code"),
  }));
  return parseSha256Digest(canonicalDigest({
    domain: SET_DOMAIN,
    records: pending.sort((left, right) => left.reconciliationId.localeCompare(right.reconciliationId)),
  }));
}


/**
 * Fail closed unless every `needs-operator` reconciliation is settled by an
 * APPROVED gate proof that is current on every bound dimension. The proof is
 * found and revalidated through the landed gate primitives, so a rejected
 * decision, a superseded plan, a different phase, or a different pending set all
 * refuse settlement rather than passing silently.
 */
export function assertReconciliationsSettled(input: {
  records: readonly PreparationReconciliationV1[];
  gateProofs: readonly GateProofSummaryV1[];
  gateId: string;
  currentPlanDigest: Sha256Digest;
  phaseDigest: Sha256Digest;
  authorityDigest: Sha256Digest;
  effectDigest?: Sha256Digest;
}): void {
  let record: Readonly<Record<string, unknown>>;
  try {
    record = captureOwnDataRecord(input);
  } catch {
    throw new ReconciliationAuthorityError("invalid-reconciliation");
  }
  const pending = pendingOperatorReconciliations(record.records as readonly PreparationReconciliationV1[]);
  if (pending.length === 0) return;
  const proofs = captureGateProofs(record.gateProofs);
  const proof = findApprovedGateProof(proofs, safeComponent(record.gateId), parseSha256Digest(record.currentPlanDigest));
  if (proof === undefined) throw new ReconciliationAuthorityError("needs-operator-gate-missing");
  revalidateApprovedGateProof(proof, {
    planDigest: parseSha256Digest(record.currentPlanDigest), phaseDigest: parseSha256Digest(record.phaseDigest),
    inputDigest: reconciliationSetDigest(pending), authorityDigest: parseSha256Digest(record.authorityDigest),
    ...(record.effectDigest === undefined ? {} : { effectDigest: parseSha256Digest(record.effectDigest) }),
  });
}

/** Capture the persisted gate-proof container by own numeric descriptors. */
function captureGateProofs(value: unknown): readonly GateProofSummaryV1[] {
  try {
    return captureDenseArray(value, MAX_PROPOSAL_REFS,
      (item) => captureOwnDataRecord(deepCaptureData(item)) as unknown as GateProofSummaryV1,
      () => new ReconciliationAuthorityError("needs-operator-gate-missing"));
  } catch (error) {
    throw error instanceof ReconciliationAuthorityError
      ? error : new ReconciliationAuthorityError("needs-operator-gate-missing");
  }
}

/**
 * Fail closed when a DEFERRED proposal is one the output contract requires. A
 * deferral is honest incompleteness, never a substitute for required output.
 */
export function assertDeferPermitted(input: {
  records: readonly PreparationReconciliationV1[];
  requiredProposalIds: readonly string[];
}): void {
  let record: Readonly<Record<string, unknown>>;
  try {
    record = captureOwnDataRecord(input);
  } catch {
    throw new ReconciliationAuthorityError("invalid-reconciliation");
  }
  const required = new Set(captureIdentityList(record.requiredProposalIds, MAX_PROPOSAL_REFS, "invalid-reconciliation"));
  const deferred = captureReconciliationList(record.records).filter((entry) => entry.decision === "defer");
  if (deferred.some((entry) => captureProposalIdList(entry.proposalIds).some((id) => required.has(id)))) {
    throw new ReconciliationAuthorityError("defer-not-optional");
  }
}
