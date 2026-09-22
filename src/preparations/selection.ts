/**
 * @file src/preparations/selection.ts
 * @description Host-authored source selection (design section 20) and the CLOSED
 * policy vocabulary every host authority module shares. A selection decision is
 * authored by the host over the EXACT candidate, eligibility, ranking, and limit
 * digests: the candidate-set digest is recomputed from the candidate identities
 * (a caller-supplied digest is refused outright), every candidate must be
 * accounted for exactly once as selected or excluded, and every exclusion reason
 * comes from the reason-code vocabulary a REGISTERED host-handler contract
 * declares — never a free-form callback and never provider prose. Untrusted
 * rationale evidence is carried but deliberately excluded from the authority
 * binding, so a provider suggestion can explain a decision it can never author.
 */

import { canonicalDigest } from "../profile/templates/signing/canonical.js";
import { parseSha256Digest } from "../capability-providers/ids.js";
import {
  captureDenseArray, captureExactRecord, captureOwnDataRecord, deepCaptureData,
} from "../utils/runtime-capture.js";
import { OPERATION_MUTATION_KINDS } from "../operation-bundles/adapter-registry.js";
import { captureEvidenceRef, captureEvidenceRefs } from "./evidence-capture.js";
import { assertSafeComponent } from "./ids.js";
import type { HostHandlerRefV1 } from "./attempts/types.js";
import type { EvidenceRefV1, Sha256Digest } from "./types.js";

/** Closed reason a selection or policy-contract capture failed closed. */
export type SelectionCode =
  | "invalid-selection" | "invalid-contract" | "contract-unbound" | "mutation-kind-proposal"
  | "unknown-candidate" | "duplicate-candidate" | "limit-exceeded" | "incomplete-coverage"
  | "unknown-reason-code" | "missing-reason-code" | "invalid-producer";

/** Typed refusal raised for every selection and policy-contract failure. */
export class SelectionAuthorityError extends Error {
  readonly code: SelectionCode;
  constructor(code: SelectionCode) {
    super(`preparation selection authority: ${code}`);
    this.name = "SelectionAuthorityError";
    this.code = code;
  }
}

/**
 * The CLOSED policy vocabulary one registered WOP host-handler contract declares.
 * Selection, reconciliation, and proposal normalization all read their permitted
 * codes and kinds from here; none of them accepts a caller-supplied predicate.
 */
export interface PreparationPolicyContractV1 {
  readonly handlerId: string;
  readonly handlerContractVersion: string;
  readonly handlerContractDigest: Sha256Digest;
  readonly exclusionReasonCodes: readonly string[];
  readonly reconciliationReasonCodes: readonly string[];
  readonly proposalKinds: readonly string[];
}

/** The registry WOP installs; a unit test injects a fake resolution. */
export interface PreparationPolicyRegistryV1 {
  resolve(ref: HostHandlerRefV1): PreparationPolicyContractV1;
}

/** One excluded candidate and the closed reason codes that excluded it. */
export interface SelectionExclusionV1 {
  readonly candidateId: string;
  readonly reasonCodes: readonly string[];
}

/** The host-authored selection decision (design section 20.1). */
export interface SelectionDecisionV1 {
  readonly schemaVersion: 1;
  readonly selectionId: string;
  readonly candidateSetRef: EvidenceRefV1;
  readonly candidateSetDigest: Sha256Digest;
  readonly eligibilityPolicyDigest: Sha256Digest;
  readonly rankingPolicyDigest?: Sha256Digest;
  readonly selectedIds: readonly string[];
  readonly excluded: readonly SelectionExclusionV1[];
  readonly selectionLimit: number;
  readonly rationaleEvidenceRefs: readonly EvidenceRefV1[];
  readonly producedBy: "host-policy" | "operator-gate";
  readonly policyContractDigest: Sha256Digest;
  readonly selectionDigest: Sha256Digest;
}

/** The host inputs one selection decision is authored from. */
export interface SelectionAuthorInputV1 {
  readonly selectionId: string;
  readonly contract: PreparationPolicyContractV1;
  readonly candidateSetRef: EvidenceRefV1;
  readonly candidateIds: unknown;
  readonly eligibilityPolicyDigest: Sha256Digest;
  readonly rankingPolicyDigest?: Sha256Digest;
  readonly selectionLimit: number;
  readonly selectedIds: unknown;
  readonly excluded: unknown;
  readonly rationaleEvidenceRefs: readonly EvidenceRefV1[];
  readonly producedBy: "host-policy" | "operator-gate";
}

/**
 * EVERY dimension bound into `selectionDigest`. A change to any one of them is
 * selection drift (design section 20.2) and invalidates dependent phase inputs,
 * gates, and completeness. A future decision field must be classified here or in
 * {@link SELECTION_BINDING_EXCLUSIONS}; the invariant test enforces that.
 */
export const SELECTION_BINDING_DIMENSIONS = Object.freeze([
  "selectionId", "candidateSetDigest", "eligibilityPolicyDigest", "rankingPolicyDigest",
  "selectedIds", "excluded", "selectionLimit", "producedBy", "policyContractDigest",
] as const);

/**
 * Decision fields DELIBERATELY outside the binding: the schema constant, the
 * evidence POINTER whose content digest is already bound, the UNTRUSTED rationale
 * (provider prose can never change the authority), and the digest itself.
 */
export const SELECTION_BINDING_EXCLUSIONS = Object.freeze([
  "schemaVersion", "candidateSetRef", "rationaleEvidenceRefs", "selectionDigest",
] as const);

const SELECTION_INPUT_KEYS = Object.freeze([
  "selectionId", "contract", "candidateSetRef", "candidateIds", "eligibilityPolicyDigest",
  "selectionLimit", "selectedIds", "excluded", "rationaleEvidenceRefs", "producedBy",
] as const);
const OPTIONAL_SELECTION_INPUT_KEYS = Object.freeze(["rankingPolicyDigest"] as const);
const PRODUCERS = Object.freeze(["host-policy", "operator-gate"] as const);
const CONTRACT_KEYS = Object.freeze([
  "handlerId", "handlerContractVersion", "handlerContractDigest",
  "exclusionReasonCodes", "reconciliationReasonCodes", "proposalKinds",
] as const);
const VOCABULARY_KEYS = Object.freeze([
  "exclusionReasonCodes", "reconciliationReasonCodes", "proposalKinds",
] as const);

const MAX_CANDIDATES = 4_096;
const MAX_VOCABULARY_TERMS = 256;
const MAX_REASON_CODES = 16;
const CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CANDIDATE_DOMAIN = "llmwiki-preparation-candidate-set-v1";
const CONTRACT_DOMAIN = "llmwiki-preparation-policy-contract-v1";
const SELECTION_DOMAIN = "llmwiki-preparation-selection-binding-v1";

/** Validate one safe identity component, refusing with this module's code. */
function safeComponent(value: unknown): string {
  try {
    return assertSafeComponent(value);
  } catch {
    throw new SelectionAuthorityError("invalid-selection");
  }
}

/** Capture one bounded closed vocabulary of lowercase reason codes or kinds. */
function captureVocabulary(value: unknown): readonly string[] {
  let terms: readonly string[];
  try {
    terms = captureDenseArray(value, MAX_VOCABULARY_TERMS, (item) => {
      if (typeof item !== "string" || !CODE_PATTERN.test(item)) throw new SelectionAuthorityError("invalid-contract");
      return item;
    }, () => new SelectionAuthorityError("invalid-contract"));
  } catch (error) {
    throw error instanceof SelectionAuthorityError ? error : new SelectionAuthorityError("invalid-contract");
  }
  if (new Set(terms).size !== terms.length) throw new SelectionAuthorityError("invalid-contract");
  return Object.freeze([...terms].sort());
}

/**
 * Normalize one policy contract into the CAPTURED form every host authority
 * enforces against. Each vocabulary is rebuilt through {@link captureVocabulary},
 * so a contract that RECORDS one vocabulary while ENFORCING another — an
 * array-like, an iterable, or a `toJSON` shim that canonicalization honours but
 * membership tests do not — fails closed instead of producing a byte-identical
 * {@link policyContractDigest}. A contract that tries to declare a Milestone A
 * mutation kind as a proposal kind is refused too: proposal kinds are Spec 3
 * data contracts and are never executable authority (design section 21.1).
 */
export function assertCapturedPolicyContract(value: unknown): PreparationPolicyContractV1 {
  let record: Readonly<Record<string, unknown>>;
  try {
    record = captureExactRecord(value, CONTRACT_KEYS);
  } catch {
    throw new SelectionAuthorityError("invalid-contract");
  }
  const vocabularies = Object.create(null) as Record<(typeof VOCABULARY_KEYS)[number], readonly string[]>;
  for (const key of VOCABULARY_KEYS) vocabularies[key] = captureVocabulary(record[key]);
  const reserved = new Set<string>(OPERATION_MUTATION_KINDS);
  if (vocabularies.proposalKinds.some((kind) => reserved.has(kind))) {
    throw new SelectionAuthorityError("mutation-kind-proposal");
  }
  return Object.freeze({
    handlerId: contractComponent(record.handlerId),
    handlerContractVersion: contractComponent(record.handlerContractVersion),
    handlerContractDigest: contractDigest(record.handlerContractDigest), ...vocabularies,
  });
}

/** Validate one safe contract component, refusing with the contract code. */
function contractComponent(value: unknown): string {
  try {
    return assertSafeComponent(value);
  } catch {
    throw new SelectionAuthorityError("invalid-contract");
  }
}

/** Parse one contract-bound digest, refusing with the contract code. */
function contractDigest(value: unknown): Sha256Digest {
  try {
    return parseSha256Digest(value);
  } catch {
    throw new SelectionAuthorityError("invalid-contract");
  }
}

/**
 * Resolve and deep-capture one registered policy contract. The `resolve`
 * callable is bound ONCE and the resolved contract must bind the exact sealed
 * handler ref.
 */
export function capturePolicyContract(
  registry: PreparationPolicyRegistryV1, ref: HostHandlerRefV1,
): PreparationPolicyContractV1 {
  const resolve = registry.resolve.bind(registry);
  let resolved: unknown;
  try {
    resolved = resolve(ref);
  } catch {
    throw new SelectionAuthorityError("invalid-contract");
  }
  const contract = assertCapturedPolicyContract(resolved);
  if (contract.handlerId !== ref.handlerId
    || contract.handlerContractVersion !== ref.handlerContractVersion
    || contract.handlerContractDigest !== ref.handlerContractDigest) {
    throw new SelectionAuthorityError("contract-unbound");
  }
  return contract;
}

/**
 * Recompute the canonical digest of one registered policy contract. The contract
 * is re-captured first, so the digest can only ever attest to the vocabulary a
 * membership test would actually enforce.
 */
export function policyContractDigest(contract: PreparationPolicyContractV1): Sha256Digest {
  const captured = assertCapturedPolicyContract(contract);
  return parseSha256Digest(canonicalDigest({
    domain: CONTRACT_DOMAIN, handlerId: captured.handlerId,
    handlerContractVersion: captured.handlerContractVersion,
    handlerContractDigest: captured.handlerContractDigest,
    exclusionReasonCodes: captured.exclusionReasonCodes,
    reconciliationReasonCodes: captured.reconciliationReasonCodes,
    proposalKinds: captured.proposalKinds,
  }));
}

/** Capture one bounded list of candidate or selected identities, order preserved. */
function captureIdentities(value: unknown): readonly string[] {
  try {
    return captureDenseArray(value, MAX_CANDIDATES, (item) => {
      if (typeof item !== "string" || !IDENTITY_PATTERN.test(item)) throw new SelectionAuthorityError("invalid-selection");
      return item;
    }, () => new SelectionAuthorityError("invalid-selection"));
  } catch (error) {
    throw error instanceof SelectionAuthorityError ? error : new SelectionAuthorityError("invalid-selection");
  }
}

/** Capture the exclusion list, closing each entry's reasons to the contract. */
function captureExclusions(value: unknown, contract: PreparationPolicyContractV1): readonly SelectionExclusionV1[] {
  const permitted = new Set(contract.exclusionReasonCodes);
  try {
    return captureDenseArray(value, MAX_CANDIDATES, (item) => {
      const entry = captureOwnDataRecord(item);
      const keys = Object.keys(entry);
      if (keys.length !== 2 || !keys.includes("candidateId") || !keys.includes("reasonCodes")) {
        throw new SelectionAuthorityError("invalid-selection");
      }
      const reasonCodes = captureDenseArray(entry.reasonCodes, MAX_REASON_CODES, (code) => {
        if (typeof code !== "string" || !permitted.has(code)) throw new SelectionAuthorityError("unknown-reason-code");
        return code;
      }, () => new SelectionAuthorityError("invalid-selection"));
      if (reasonCodes.length === 0) throw new SelectionAuthorityError("missing-reason-code");
      return Object.freeze({ candidateId: captureIdentities([entry.candidateId])[0]!, reasonCodes });
    }, () => new SelectionAuthorityError("invalid-selection"));
  } catch (error) {
    throw error instanceof SelectionAuthorityError ? error : new SelectionAuthorityError("invalid-selection");
  }
}

/** Fail closed unless every candidate is accounted for exactly once. */
function assertCompleteCoverage(
  candidateIds: readonly string[], selectedIds: readonly string[],
  excluded: readonly SelectionExclusionV1[], selectionLimit: number,
): void {
  const classified = [...selectedIds, ...excluded.map((entry) => entry.candidateId)];
  if (new Set(classified).size !== classified.length) throw new SelectionAuthorityError("duplicate-candidate");
  const candidates = new Set(candidateIds);
  if (candidates.size !== candidateIds.length) throw new SelectionAuthorityError("duplicate-candidate");
  if (classified.some((identity) => !candidates.has(identity))) {
    throw new SelectionAuthorityError("unknown-candidate");
  }
  if (!Number.isSafeInteger(selectionLimit) || selectionLimit < 0) throw new SelectionAuthorityError("invalid-selection");
  if (selectedIds.length > selectionLimit) throw new SelectionAuthorityError("limit-exceeded");
  if (classified.length !== candidates.size) throw new SelectionAuthorityError("incomplete-coverage");
}

/**
 * Bind the COMPLETE selection authority into one canonical digest, driven by
 * {@link SELECTION_BINDING_DIMENSIONS}. One primitive builds it, so no bound
 * dimension can drift out of the binding as the decision shape grows.
 */
function completeSelectionBinding(source: Readonly<Record<string, unknown>>): Sha256Digest {
  const claim: Record<string, unknown> = { domain: SELECTION_DOMAIN };
  for (const key of SELECTION_BINDING_DIMENSIONS) claim[key] = source[key];
  return parseSha256Digest(canonicalDigest(claim));
}

/** Capture the author input against the closed key allowlist before any use. */
function captureSelectionInput(input: SelectionAuthorInputV1): Readonly<Record<string, unknown>> {
  let record: Readonly<Record<string, unknown>>;
  try {
    record = captureOwnDataRecord(input);
  } catch {
    throw new SelectionAuthorityError("invalid-selection");
  }
  const allowed = new Set<string>([...SELECTION_INPUT_KEYS, ...OPTIONAL_SELECTION_INPUT_KEYS]);
  if (SELECTION_INPUT_KEYS.some((key) => record[key] === undefined)
    || Object.keys(record).some((key) => !allowed.has(key))) {
    throw new SelectionAuthorityError("invalid-selection");
  }
  return record;
}

/**
 * Author one host-owned selection decision. Nothing about the decision is taken
 * on faith: the candidate-set digest is RECOMPUTED from the canonical sorted
 * candidate identities, coverage and the limit are enforced against that exact
 * set, exclusion reasons are closed to the registered contract, and the whole
 * authority is bound into one recomputable `selectionDigest`.
 */
export function authorSelectionDecision(input: SelectionAuthorInputV1): SelectionDecisionV1 {
  const record = captureSelectionInput(input);
  if (!(PRODUCERS as readonly string[]).includes(record.producedBy as string)) {
    throw new SelectionAuthorityError("invalid-producer");
  }
  const contract = assertCapturedPolicyContract(record.contract);
  const candidateIds = captureIdentities(record.candidateIds);
  const selectedIds = captureIdentities(record.selectedIds);
  const excluded = captureExclusions(record.excluded, contract);
  assertCompleteCoverage(candidateIds, selectedIds, excluded, record.selectionLimit as number);
  const bound = {
    selectionId: safeComponent(record.selectionId),
    candidateSetDigest: parseSha256Digest(canonicalDigest({
      domain: CANDIDATE_DOMAIN, candidateIds: [...candidateIds].sort(),
    })),
    eligibilityPolicyDigest: parseSha256Digest(record.eligibilityPolicyDigest),
    ...(record.rankingPolicyDigest === undefined
      ? {} : { rankingPolicyDigest: parseSha256Digest(record.rankingPolicyDigest) }),
    selectedIds, excluded, selectionLimit: record.selectionLimit as number,
    producedBy: record.producedBy as SelectionDecisionV1["producedBy"],
    policyContractDigest: policyContractDigest(contract),
  };
  return Object.freeze({
    schemaVersion: 1 as const, candidateSetRef: captureEvidenceRef(record.candidateSetRef),
    rationaleEvidenceRefs: captureEvidenceRefs(record.rationaleEvidenceRefs), ...bound,
    selectionDigest: completeSelectionBinding(bound),
  });
}

/** Every field one complete selection decision carries, bound or excluded. */
const SELECTION_DECISION_KEYS = Object.freeze([
  ...SELECTION_BINDING_DIMENSIONS, ...SELECTION_BINDING_EXCLUSIONS,
] as const);

/** The one decision field that may be absent from an authentic record. */
const OPTIONAL_SELECTION_DECISION_KEYS = Object.freeze(["rankingPolicyDigest"] as const);

/**
 * Authenticate one selection decision at a CONSUMER. `SelectionDecisionV1` is
 * structural and unbranded, so a caller can hand a consumer a record no host
 * ever authored. Rather than trust its shape, this recomputes the COMPLETE
 * binding from the record's own bound dimensions — through the same primitive
 * {@link authorSelectionDecision} used — and refuses a record whose
 * `selectionDigest` does not match. Authenticate, never trust.
 */
export function assertSelectionDecisionAuthentic(value: unknown): SelectionDecisionV1 {
  let record: Readonly<Record<string, unknown>>;
  try {
    record = captureOwnDataRecord(deepCaptureData(value));
  } catch {
    throw new SelectionAuthorityError("invalid-selection");
  }
  const allowed = new Set<string>(SELECTION_DECISION_KEYS);
  const optional = new Set<string>(OPTIONAL_SELECTION_DECISION_KEYS);
  if (Object.keys(record).some((key) => !allowed.has(key))
    || SELECTION_DECISION_KEYS.some((key) => record[key] === undefined && !optional.has(key))) {
    throw new SelectionAuthorityError("invalid-selection");
  }
  if (completeSelectionBinding(record) !== record.selectionDigest) {
    throw new SelectionAuthorityError("invalid-selection");
  }
  return Object.freeze({ ...record }) as unknown as SelectionDecisionV1;
}
