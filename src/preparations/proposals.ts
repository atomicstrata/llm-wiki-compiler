/**
 * @file src/preparations/proposals.ts
 * @description Provider and host preparation output becomes BOUNDED PROPOSAL
 * EVIDENCE ONLY (design section 21.1). A draft may say three things and no more:
 * which Spec 3-declared proposal kind it belongs to, which LOGICAL identity it is
 * about, and what value it proposes. It may not name a path, a writer, a store, a
 * command, a URL, a payload reference, a Milestone A mutation kind, or its own
 * identity/digests — every one of those is either an unknown key or a reserved
 * kind and fails closed here. The host derives the proposal identity, the value
 * digest, and the provenance digest itself from the captured bytes and the
 * host-observed attempt/provider pin, so a provider cannot forge a proposal that
 * appears to come from somewhere else. Normalization is pure: it opens no file,
 * touches no store, and returns deep-frozen data-only evidence.
 */

import { canonicalBytes, canonicalDigest } from "../profile/templates/signing/canonical.js";
import { parseSha256Digest } from "../capability-providers/ids.js";
import { captureDenseArray, captureOwnDataRecord, deepCaptureData } from "../utils/runtime-capture.js";
import { OPERATION_MUTATION_KINDS } from "../operation-bundles/adapter-registry.js";
import { captureEvidenceRefs } from "./evidence-capture.js";
import { assertAttemptId, type AttemptId } from "./ids.js";
import { assertCapturedPolicyContract, type PreparationPolicyContractV1 } from "./selection.js";
import type { EvidenceRefV1, Sha256Digest } from "./types.js";

/** The THREE and only fields an untrusted provider draft may carry. */
export const PROPOSAL_DRAFT_KEYS = Object.freeze([
  "proposalKind", "targetLogicalIdentity", "proposedValue",
] as const);

const REQUIRED_DRAFT_KEYS = Object.freeze(["proposalKind", "proposedValue"] as const);

/** The host-supplied normalize inputs; every one is captured before any use. */
const NORMALIZE_INPUT_KEYS = Object.freeze([
  "contract", "attemptId", "providerPinDigest", "sourceEvidenceRefs", "drafts",
] as const);
const OPTIONAL_NORMALIZE_INPUT_KEYS = Object.freeze(["maximumProposals"] as const);

/** Every field one complete normalized proposal carries. */
const PROPOSAL_KEYS = Object.freeze([
  "schemaVersion", "proposalId", "proposalKind", "sourceEvidenceRefs",
  "targetLogicalIdentity", "proposedValueDigest", "provenanceDigest",
] as const);
const OPTIONAL_PROPOSAL_KEYS = Object.freeze(["targetLogicalIdentity"] as const);

const MAX_PROPOSALS = 256;
/**
 * The canonical byte cap on one captured proposal value — the TIGHTEST ceiling
 * a proposed mutation crosses, four times tighter than a phase's own output
 * bound. Exported so a producer can refuse BEFORE doing irreversible work
 * rather than discovering the cap after it.
 */
const MAX_PROPOSAL_VALUE_BYTES = 64 * 1024;
const KIND_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/**
 * A LOGICAL identity: letters, digits, and the three separators. It admits no
 * path separator, no traversal segment start, no drive letter colon-backslash,
 * no URL scheme slash, no NUL, and no empty value — a proposal names a thing,
 * never a location.
 */
const LOGICAL_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
/** The canonical envelope domain a proposal value is digested under. */
const PROPOSAL_VALUE_DOMAIN = "llmwiki-preparation-proposal-value-v1";
const VALUE_DOMAIN = PROPOSAL_VALUE_DOMAIN;
const PROVENANCE_DOMAIN = "llmwiki-preparation-proposal-provenance-v1";
const IDENTITY_DOMAIN = "llmwiki-preparation-proposal-identity-v1";

/** Closed reason a provider proposal failed closed. */
export type ProposalCode =
  | "invalid-proposal" | "unknown-proposal-kind" | "mutation-kind-proposal"
  | "invalid-target-identity" | "proposal-cap-exceeded" | "proposal-too-large"
  | "duplicate-proposal" | "missing-evidence";

/** Typed refusal raised for every proposal normalization failure. */
export class ProposalAuthorityError extends Error {
  readonly code: ProposalCode;
  constructor(code: ProposalCode) {
    super(`preparation proposal authority: ${code}`);
    this.name = "ProposalAuthorityError";
    this.code = code;
  }
}

/**
 * One immutable normalized proposal (design section 21.1). The spec's optional
 * `confidenceEvidenceRef` is deliberately never populated from a draft: provider
 * confidence is untrusted prose and travels as an ordinary source evidence
 * object, not as a host-minted confidence claim.
 */
export interface PreparationProposalV1 {
  readonly schemaVersion: 1;
  readonly proposalId: string;
  readonly proposalKind: string;
  readonly sourceEvidenceRefs: readonly EvidenceRefV1[];
  readonly targetLogicalIdentity?: string;
  readonly proposedValueDigest: Sha256Digest;
  readonly provenanceDigest: Sha256Digest;
}

/** The host-observed context every normalized proposal is bound to. */
export interface ProposalNormalizeInputV1 {
  readonly contract: PreparationPolicyContractV1;
  readonly attemptId: AttemptId;
  readonly providerPinDigest: Sha256Digest;
  readonly sourceEvidenceRefs: readonly EvidenceRefV1[];
  readonly drafts: unknown;
  readonly maximumProposals?: number;
}

/** The resolved host authority one draft is normalized against. */
interface NormalizeContext {
  readonly permittedKinds: ReadonlySet<string>;
  readonly reservedKinds: ReadonlySet<string>;
  readonly attemptId: AttemptId;
  readonly providerPinDigest: Sha256Digest;
  readonly sourceEvidenceRefs: readonly EvidenceRefV1[];
  readonly sourceEvidenceDigests: readonly Sha256Digest[];
}

/** Deep-capture one untrusted draft against the closed three-key allowlist. */
function captureDraft(item: unknown): Readonly<Record<string, unknown>> {
  let record: Readonly<Record<string, unknown>>;
  try {
    record = captureOwnDataRecord(deepCaptureData(item));
  } catch {
    throw new ProposalAuthorityError("invalid-proposal");
  }
  const allowed = new Set<string>(PROPOSAL_DRAFT_KEYS);
  if (Object.keys(record).some((key) => !allowed.has(key))
    || REQUIRED_DRAFT_KEYS.some((key) => record[key] === undefined)) {
    throw new ProposalAuthorityError("invalid-proposal");
  }
  return record;
}

/** Capture the bounded draft list, failing closed above the declared maximum. */
function captureDrafts(value: unknown, maximum: number): readonly Readonly<Record<string, unknown>>[] {
  try {
    return captureDenseArray(value, maximum, captureDraft,
      () => new ProposalAuthorityError("proposal-cap-exceeded"));
  } catch (error) {
    throw error instanceof ProposalAuthorityError ? error : new ProposalAuthorityError("invalid-proposal");
  }
}

/** Resolve the draft's kind against the reserved and registered vocabularies. */
function resolveKind(record: Readonly<Record<string, unknown>>, context: NormalizeContext): string {
  const kind = record.proposalKind;
  if (typeof kind !== "string" || !KIND_PATTERN.test(kind)) throw new ProposalAuthorityError("invalid-proposal");
  if (context.reservedKinds.has(kind)) throw new ProposalAuthorityError("mutation-kind-proposal");
  if (!context.permittedKinds.has(kind)) throw new ProposalAuthorityError("unknown-proposal-kind");
  return kind;
}

/** Resolve the optional LOGICAL target identity; a location never qualifies. */
function resolveTarget(record: Readonly<Record<string, unknown>>): string | undefined {
  if (record.targetLogicalIdentity === undefined) return undefined;
  const target = record.targetLogicalIdentity;
  if (typeof target !== "string" || !LOGICAL_IDENTITY_PATTERN.test(target)) {
    throw new ProposalAuthorityError("invalid-target-identity");
  }
  return target;
}

/** Digest the captured proposed value, failing closed above the byte cap. */
function digestProposedValue(value: unknown): Sha256Digest {
  let bytes: Buffer;
  try {
    bytes = canonicalBytes({ domain: VALUE_DOMAIN, value });
  } catch {
    throw new ProposalAuthorityError("invalid-proposal");
  }
  if (bytes.byteLength > MAX_PROPOSAL_VALUE_BYTES) throw new ProposalAuthorityError("proposal-too-large");
  return parseSha256Digest(canonicalDigest({ domain: VALUE_DOMAIN, value }));
}

/** Derive the host proposal identity from the two digests it is bound to. */
function proposalIdFor(provenanceDigest: Sha256Digest, proposedValueDigest: Sha256Digest): string {
  const identity = canonicalDigest({ domain: IDENTITY_DOMAIN, provenanceDigest, proposedValueDigest });
  return `ppl_${identity.slice("sha256:".length)}`;
}

/** Normalize one captured draft into immutable, host-identified evidence. */
function normalizeDraft(
  record: Readonly<Record<string, unknown>>, context: NormalizeContext,
): PreparationProposalV1 {
  const proposalKind = resolveKind(record, context);
  const targetLogicalIdentity = resolveTarget(record);
  const proposedValueDigest = digestProposedValue(record.proposedValue);
  const provenanceDigest = parseSha256Digest(canonicalDigest({
    domain: PROVENANCE_DOMAIN, attemptId: context.attemptId, providerPinDigest: context.providerPinDigest,
    sourceEvidenceDigests: context.sourceEvidenceDigests, proposalKind,
    targetLogicalIdentity: targetLogicalIdentity ?? null,
  }));
  return Object.freeze({
    schemaVersion: 1 as const, proposalId: proposalIdFor(provenanceDigest, proposedValueDigest), proposalKind,
    sourceEvidenceRefs: context.sourceEvidenceRefs,
    ...(targetLogicalIdentity === undefined ? {} : { targetLogicalIdentity }),
    proposedValueDigest, provenanceDigest,
  });
}

/** Capture the normalize input against the closed key allowlist before any use. */
function captureNormalizeInput(input: ProposalNormalizeInputV1): Readonly<Record<string, unknown>> {
  let record: Readonly<Record<string, unknown>>;
  try {
    record = captureOwnDataRecord(input);
  } catch {
    throw new ProposalAuthorityError("invalid-proposal");
  }
  const allowed = new Set<string>([...NORMALIZE_INPUT_KEYS, ...OPTIONAL_NORMALIZE_INPUT_KEYS]);
  if (NORMALIZE_INPUT_KEYS.some((key) => record[key] === undefined)
    || Object.keys(record).some((key) => !allowed.has(key))) {
    throw new ProposalAuthorityError("invalid-proposal");
  }
  return record;
}

/**
 * Resolve the host-observed authority ONE captured source-evidence list is bound
 * to. The captured list is both STORED on every proposal and DIGESTED into every
 * provenance binding, so the evidence a proposal carries and the evidence its
 * provenance attests to are the same bytes by construction.
 */
function resolveNormalizeContext(record: Readonly<Record<string, unknown>>): NormalizeContext {
  const contract = assertCapturedPolicyContract(record.contract);
  let sourceEvidenceRefs: readonly EvidenceRefV1[];
  try {
    sourceEvidenceRefs = captureEvidenceRefs(record.sourceEvidenceRefs);
  } catch {
    throw new ProposalAuthorityError("missing-evidence");
  }
  if (sourceEvidenceRefs.length === 0) throw new ProposalAuthorityError("missing-evidence");
  return {
    permittedKinds: new Set(contract.proposalKinds),
    reservedKinds: new Set<string>(OPERATION_MUTATION_KINDS),
    attemptId: assertAttemptId(record.attemptId),
    providerPinDigest: parseSha256Digest(record.providerPinDigest),
    sourceEvidenceRefs,
    sourceEvidenceDigests: Object.freeze(sourceEvidenceRefs.map((ref) => ref.digest)),
  };
}

/**
 * Normalize an UNTRUSTED provider draft set into bounded proposal evidence. The
 * host supplies the attempt, the provider pin, and the source evidence; the
 * drafts supply nothing but kind, logical identity, and value. Every input is
 * captured ONCE and read only from that copy. Two drafts that normalize to the
 * same host identity are a refusal rather than a silent collapse, so a duplicated
 * proposal can never be counted twice.
 */
export function normalizeProviderProposals(
  input: ProposalNormalizeInputV1,
): readonly PreparationProposalV1[] {
  const record = captureNormalizeInput(input);
  const context = resolveNormalizeContext(record);
  const declared = record.maximumProposals;
  const maximum = Math.min(typeof declared === "number" ? declared : MAX_PROPOSALS, MAX_PROPOSALS);
  const proposals = captureDrafts(record.drafts, maximum)
    .map((draft) => normalizeDraft(draft, context));
  if (new Set(proposals.map((proposal) => proposal.proposalId)).size !== proposals.length) {
    throw new ProposalAuthorityError("duplicate-proposal");
  }
  return Object.freeze(proposals);
}

/**
 * Authenticate one proposal at a CONSUMER. `PreparationProposalV1` is structural
 * and unbranded, so a caller can hand a consumer a record no host ever
 * normalized. The host identity is RECOMPUTED from the record's own provenance
 * and value digests through {@link proposalIdFor} — the same primitive that
 * minted it — and a record whose id does not match is refused.
 */
export function assertProposalAuthentic(value: unknown): PreparationProposalV1 {
  let record: Readonly<Record<string, unknown>>;
  try {
    record = captureOwnDataRecord(deepCaptureData(value));
  } catch {
    throw new ProposalAuthorityError("invalid-proposal");
  }
  const allowed = new Set<string>(PROPOSAL_KEYS);
  const optional = new Set<string>(OPTIONAL_PROPOSAL_KEYS);
  if (Object.keys(record).some((key) => !allowed.has(key))
    || PROPOSAL_KEYS.some((key) => record[key] === undefined && !optional.has(key))) {
    throw new ProposalAuthorityError("invalid-proposal");
  }
  return buildAuthenticProposal(record);
}

/** Rebuild one authenticated proposal, refusing a mismatched host identity. */
function buildAuthenticProposal(record: Readonly<Record<string, unknown>>): PreparationProposalV1 {
  let rebuilt: PreparationProposalV1;
  try {
    const provenanceDigest = parseSha256Digest(record.provenanceDigest);
    const proposedValueDigest = parseSha256Digest(record.proposedValueDigest);
    rebuilt = Object.freeze({
      schemaVersion: 1 as const, proposalId: proposalIdFor(provenanceDigest, proposedValueDigest),
      proposalKind: resolveKindPattern(record.proposalKind),
      sourceEvidenceRefs: captureEvidenceRefs(record.sourceEvidenceRefs),
      ...(record.targetLogicalIdentity === undefined
        ? {} : { targetLogicalIdentity: resolveTarget(record) }),
      proposedValueDigest, provenanceDigest,
    });
  } catch (error) {
    throw error instanceof ProposalAuthorityError ? error : new ProposalAuthorityError("invalid-proposal");
  }
  if (rebuilt.proposalId !== record.proposalId || record.schemaVersion !== 1) {
    throw new ProposalAuthorityError("invalid-proposal");
  }
  return rebuilt;
}

/** Validate one proposal kind's grammar without consulting a contract. */
function resolveKindPattern(value: unknown): string {
  if (typeof value !== "string" || !KIND_PATTERN.test(value)) {
    throw new ProposalAuthorityError("invalid-proposal");
  }
  return value;
}
