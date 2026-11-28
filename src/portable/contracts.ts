/**
 * @file src/portable/contracts.ts
 * @description The shapes the portable project path is built from: identities,
 * adapter capabilities, permissions, the principal a host derives, object
 * images, and the records the publication authority persists.
 *
 * Nothing here is a filesystem path. A project is named by a host-issued id and
 * its objects by logical paths, so the same shapes describe a local directory
 * and a store with no directories at all. Names ending `V1` are persisted or
 * sent over the wire; changing one is a format change.
 */

/** SHA-256 of some bytes, as `sha256:<hex>`. Equal digests mean equal bytes. */
export type ContentDigest = `sha256:${string}`;

/** Compartment ids, sorted and de-duplicated. Empty never means public. */
export type LabelSet = readonly string[];

/** What an adapter guarantees. An operation needing more is refused, never emulated. */
export interface AdapterCapabilitiesV1 {
  conditionalWrite: "per-object-cas" | "none";
  batchPublish: "atomic-pointer-swap" | "journalled-cooperative" | "none";
  /** Whether bytes, their labels and the receipt are covered by ONE protocol. */
  receiptCustody: "atomic-with-bytes" | "journalled-cooperative" | "declared-protocol" | "none";
  snapshotRead: "head-consistent" | "none";
  historyRetention: { retained: "none" };
  projectRevision: "monotonic" | "none";
  listConsistency: "revision-fenced" | "validate-digest";
  durability: "power-loss" | "crash-consistent" | "volatile";
  externalWriters: "possible" | "excluded";
  limits: { maxObjectBytes: number; maxPreimageBytes: number; maxListPage: number };
}

/** The verbs the prototype checks. Deferred domains have no verb here on purpose. */
export type Permission =
  | "project.open" | "page.read" | "page.list" | "source.read" | "source.write"
  | "query.run" | "model.invoke" | "export.run" | "compile.propose"
  | "candidate.read" | "candidate.approve" | "publication.apply"
  | "operation.read" | "operation.resolve" | "ticket.issue" | "project.admin";

/** The identity a host derived for one session. A caller never supplies one. */
export interface PrincipalContext {
  tenant: string;
  project: string;
  /** The party the request is attributed to. */
  subject: string;
  /** The identity actually executing; equals `subject` unless a service runs a job. */
  actor: string;
  /** OBSERVATION ONLY: what the policy revision was when the session opened. */
  observedPolicyRevision: number;
  sessionId: string;
}

/** Pre- or post-state of one publication target. */
export type ObjectImage =
  | { state: "present"; digest: ContentDigest; byteCount: number; labels: LabelSet }
  | { state: "absent" };

/** The four authoritative writes of the prototype. */
export type OperationKind = "source.add" | "proposal.persist" | "approval.record" | "candidate.apply";

/** Why an operation left no effect. */
export const REFUSAL_CODES = [
  "stale_read_set", "target_precondition_failed", "policy_changed",
  "approval_invalid", "approval_reserved", "approval_consumed", "ticket_invalid",
  "candidate_drift", "permission_denied", "capability_unsupported",
  "operation_unsupported_on_portable_path", "limit_exceeded", "preimage_unavailable",
  "supersedes_invalid", "recovery_blocking", "recovered_no_effect",
  "publication_in_progress", "floor_blocked",
] as const;

/** One of the closed refusal codes. The list above is the set a client recognizes on the wire. */
export type RefusalCode = (typeof REFUSAL_CODES)[number];

/** The closed set of details a recovered refusal may carry. */
export const RECOVERY_DETAILS = ["never_started", "rolled_back", "no_surviving_effect"] as const;

/** How a recovered refusal came about. */
export type RecoveryDetail = (typeof RECOVERY_DETAILS)[number];

/** The closed set of reasons one submission may be rejected for. */
export const REJECTION_REASONS = [
  "operation_id_in_use", "operation_id_not_valid", "generation_superseded", "upload_digest_mismatch",
] as const;

/** A page or record the operation deliberately did not write. */
export interface SkippedItem { path: string | null; code: "floor_blocked" | "limit_exceeded" }

/** One object a committed operation published. */
export interface PublishedObject { path: string; digest: ContentDigest; labels: LabelSet }

/** What one target looked like when a parked operation was resolved. */
export interface TargetObservation { path: string; observed: "pre-image" | "post-image" | "neither" }

/** The record of an operator closing a parked operation. */
export interface ResolutionRecordV1 {
  operationId: string;
  resolver: string;
  resolvedAt: string;
  decision: ResolveDecision;
  reason: string;
  targets: readonly TargetObservation[];
}

/** The closed set of resolve decisions. */
export type ResolveDecision = "retry-recovery" | "roll-back-own-writes" | "accept-external-bytes";

/** One read made while generating, or one object an apply depends on. */
export interface DependencyObject {
  path: string;
  digest: ContentDigest | "absent";
  /**
   * The adapter's opaque token for "this object as observed", or `null` for an
   * absent read. On disk it is the stat fingerprint PLUS the content digest;
   * on a manifest store it is the revision the object was written at. It is
   * recorded as observed, never downgraded to the digest alone. Validation of
   * a semantic input compares content (§7), so a touched-but-identical file
   * does not stale an apply; the revision is what a version fence compares.
   */
  revision: string | null;
}

/** One object exactly as an adapter observed it: bytes, digest and revision together. */
export interface ObservedObject {
  bytes: Uint8Array;
  digest: ContentDigest;
  revision: string;
}

/** A listing that was evaluated, stored so the authority can re-evaluate it. */
export interface DependencyListing { prefix: string; completeListDigest: ContentDigest }

/** Every semantic input of a proposal. All of it is validated before an apply. */
export interface ApplyDependenciesV1 {
  objects: readonly DependencyObject[];
  listings: readonly DependencyListing[];
  reviewPolicyDigest: ContentDigest;
  systemPolicyDigest: ContentDigest | null;
  targets: readonly { path: string; pre: ObjectImage }[];
  /** Listings inside `proposals/**` generation used. The prototype compile uses none. */
  lineageScopedListings: readonly DependencyListing[];
}

/** A listing aid. Never enough to approve from. */
export interface CandidateSummary {
  id: string;
  targetPath: string;
  labels: LabelSet;
  candidateDigest: ContentDigest;
}

/** The receipt of a committed proposal: what was actually generated. */
export interface ProposalReceiptV1 {
  operationId: string;
  intentDigest: ContentDigest;
  candidateSetDigest: ContentDigest;
  planDigest: ContentDigest;
  applyDependenciesDigest: ContentDigest;
  candidates: readonly CandidateSummary[];
  skipped: readonly SkippedItem[];
}

/** An immutable approval: a capability for ONE committed apply of an exact subject. */
export interface ApprovalRecordV1 {
  approvalId: string;
  tenant: string;
  project: string;
  operationId: string;
  proposalOperationId: string;
  candidateSetDigest: ContentDigest;
  planDigest: ContentDigest;
  applyDependenciesDigest: ContentDigest;
  approver: string;
  proposer: string;
  policyRevision: number;
  labels: LabelSet;
  createdAt: string;
  /** Host-capped. */
  expiresAt: string;
}

/** Where an approval or ticket stands; derived from the operation that holds it. */
export type CustodyState =
  | { state: "available" }
  | { state: "reserved"; by: string }
  | { state: "consumed"; by: string };

/** The commit record of one publication: objects, labels and identity together. */
export interface ReceiptV1 {
  project: string;
  revision: number | null;
  operationId: string;
  kind: OperationKind;
  intentDigest: ContentDigest;
  resolvedPlanDigest: ContentDigest;
  actor: string;
  onBehalfOf: readonly string[];
  policyFence: { policyRevision: number; ticketRevision: number };
  published: readonly PublishedObject[];
  skipped: readonly SkippedItem[];
  consumedApprovalId: string | null;
  consumedTicketId: string | null;
  committedAt: string;
  /** The kind's own result: a proposal receipt or an approval record. */
  proposal?: ProposalReceiptV1;
  approval?: ApprovalRecordV1;
}

/** Kept for the project's lifetime. The exactly-once guarantee rests on it. */
export interface OperationIdentityRecordV1 {
  tenant: string;
  project: string;
  actor: string;
  hostIncarnation: string;
  kind: OperationKind;
  operationId: string;
  intentDigest: ContentDigest;
  outcome: "in-progress" | "committed" | "refused" | "abandoned";
  refusal: RefusalCode | null;
  detail: RecoveryDetail | null;
  /** What this operation holds: the approval, and the ticket if one was presented. */
  holds: { approvalId: string | null; ticketId: string | null };
  generationLease: { owner: string; epoch: number; expiresAt: string } | null;
  resolution: ResolutionRecordV1 | null;
  supersedes: string | null;
}

/** A statement about one SUBMISSION. Never stored, never returned by status. */
export interface SubmissionRejected {
  kind: "rejected";
  reason: (typeof REJECTION_REASONS)[number];
}

export interface Refused { kind: "refused"; operationId: string; code: RefusalCode; detail?: RecoveryDetail }
export interface InProgress { kind: "in_progress"; operationId: string }
export interface Unknown { kind: "unknown"; operationId: string }
export interface Abandoned { kind: "abandoned"; operationId: string; resolution: ResolutionRecordV1 }

/** The arms every write can return besides its own success arm. */
export type NonCommitArms = Refused | InProgress | Unknown | Abandoned | SubmissionRejected;

export interface Committed {
  kind: "committed";
  operationId: string;
  head: number | null;
  published: readonly PublishedObject[];
  skipped: readonly SkippedItem[];
}
export interface Proposed { kind: "proposed"; receipt: ProposalReceiptV1 }
export interface Approved { kind: "approved"; operationId: string; approval: ApprovalRecordV1 }

export type PublicationOutcome = Committed | NonCommitArms;
export type ProposalOutcome = Proposed | NonCommitArms;
export type ApprovalOutcome = Approved | NonCommitArms;

/** What status can answer. It never returns a submission rejection. */
export type PublicationStatus =
  | Committed | Proposed | Approved | Refused | InProgress | Unknown | Abandoned
  | { kind: "not_found" }
  | { kind: "intent_mismatch" };

/** The constant notice on every listing and search. It never varies with hidden content. */
export const ACCESS_NOTICE = "Results reflect your access";
