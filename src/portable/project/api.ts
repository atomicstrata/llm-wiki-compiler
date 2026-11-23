/**
 * @file src/portable/project/api.ts
 * @description The logical project interface: what a session can ask of a
 * project, on any backend, without ever naming a file.
 *
 * This is the exact prototype vocabulary. Every public write takes an operation
 * id allocated beforehand and may carry `supersedes`; each returns its own
 * success arm or one of the shared non-commit arms. Every other named domain is
 * present only as a typed refusal in {@link DeferredOperations}.
 */

import type {
  ACCESS_NOTICE,
  AdapterCapabilitiesV1,
  ApprovalOutcome,
  ApprovalRecordV1,
  CandidateSummary,
  ContentDigest,
  CustodyState,
  LabelSet,
  ObjectImage,
  PrincipalContext,
  ProposalOutcome,
  PublicationOutcome,
  PublicationStatus,
  ResolveDecision,
} from "../contracts.js";
import type { ExecutionTicketV1 } from "../host/control.js";

/** The constant notice type. */
export type AccessNotice = typeof ACCESS_NOTICE;

/** Absent, denied and uncleared are the same answer. */
export type LabelledResult<T> = { visible: true; value: T; labels: LabelSet } | { visible: false };

/** One published page as read: bytes, digest, revision and labels are one observation. */
export interface PageView {
  id: string;
  path: string;
  digest: ContentDigest;
  /** The adapter's opaque revision for this observation. */
  revision: string;
  body: string;
}

/** A listing entry for a page. */
export interface PageListing { id: string; path: string; title: string }

/** A source's normalized text. */
export interface SourceView { id: string; path: string; digest: ContentDigest; revision: string; text: string }

/** A listing or search result set, always carrying the same notice. */
export interface Listed<T> { items: readonly T[]; notice: AccessNotice }

/** Source bytes prepared so they can be re-sent unchanged on a same-id retry. */
export interface PreparedUpload {
  /** A CLAIM. The host hashes what it receives and refuses a mismatch. */
  byteDigest: ContentDigest;
  bytes: Uint8Array;
}

export interface AddSourceRequest {
  operationId: string;
  name: string;
  upload: PreparedUpload;
  /** A classification REQUEST, never authority. The host assigns the compartment. */
  requestedLabels?: LabelSet;
  supersedes?: string;
}

export interface ProposeRequest { operationId: string; supersedes?: string }

/** What a human reviews: enough to approve exactly what will be written. */
export interface CandidateView {
  id: string;
  proposalOperationId: string;
  targetPath: string;
  /** Creates (absent) or replaces this exact version. */
  targetPre: ObjectImage;
  /** The exact final rendered page that would be written, byte for byte. */
  draftBody: string;
  /** Re-hashed from the stored body when this view was served. */
  draftDigest: ContentDigest;
  candidateDigest: ContentDigest;
  labels: LabelSet;
  candidateSetDigest: ContentDigest;
  planDigest: ContentDigest;
  applyDependenciesDigest: ContentDigest;
}

/** Approval names EXACTLY what was reviewed; ids alone are not accepted. */
export interface ApproveRequest {
  operationId: string;
  proposalOperationId: string;
  candidateSetDigest: ContentDigest;
  planDigest: ContentDigest;
  applyDependenciesDigest: ContentDigest;
  /** A REQUEST; the host caps it and records the capped value. */
  requestedExpiresAt: string;
  supersedes?: string;
}

/** An approval as handed to a publisher: immutable bindings plus current custody. */
export interface ApprovalView { record: ApprovalRecordV1; custody: CustodyState }

export interface ApplyRequest { operationId: string; approvalId: string; ticketId?: string; supersedes?: string }

export interface ResolveRequest { operationId: string; decision: ResolveDecision; reason: string }

export type ResolveOutcome =
  | { kind: "resolved"; status: PublicationStatus }
  | { kind: "refused"; code: "decision_not_allowed" | "targets_changed" | "not_parked" };

export interface TicketRequest { approvalId: string; serviceActor: string; requestedExpiresAt: string }

export type TicketOutcome =
  | { kind: "issued"; ticket: ExecutionTicketV1 }
  | { kind: "refused"; code: "approval_invalid" | "approval_reserved" | "approval_consumed" };

/** One hit of the deterministic keyword search. */
export interface SearchHit { id: string; path: string; title: string; snippet: string }

/** One item of the labelled object stream, or the stream's explicit end. */
export type ExportItem =
  | { kind: "object"; path: string; digest: ContentDigest; revision: string; labels: LabelSet; bytes: Uint8Array }
  | { kind: "completed"; count: number }
  | { kind: "stopped"; reason: "policy_changed" | "publication_in_progress" | "limit_exceeded" | "drift" };

/** A deferred domain's only answer. */
export interface Deferred { kind: "refused"; code: "operation_unsupported_on_portable_path" }

/** One member per deferred domain; nothing here is called "delete". */
export interface DeferredOperations {
  downloadRawSource(id: string): Promise<Deferred>;
  trashSource(id: string): Promise<Deferred>;
  restoreSource(id: string): Promise<Deferred>;
  purgeSource(id: string): Promise<Deferred>;
  addRelation(input: unknown): Promise<Deferred>;
  transitionLifecycle(input: unknown): Promise<Deferred>;
  readHistory(path: string): Promise<Deferred>;
  publishDirect(): Promise<Deferred>;
  relabel(path: string, labels: LabelSet): Promise<Deferred>;
  exportLegacy(format: string): Promise<Deferred>;
}

/** The exact prototype surface of one project. */
export interface WikiProject {
  readonly id: string;
  capabilities(): Promise<AdapterCapabilitiesV1>;
  allocateOperation(): Promise<string>;
  pages: {
    get(id: string): Promise<LabelledResult<PageView>>;
    list(): Promise<Listed<PageListing>>;
  };
  sources: {
    get(id: string): Promise<LabelledResult<SourceView>>;
    add(request: AddSourceRequest): Promise<PublicationOutcome>;
  };
  propose(request: ProposeRequest): Promise<ProposalOutcome>;
  candidates: {
    list(proposalOperationId: string): Promise<Listed<CandidateSummary>>;
    get(proposalOperationId: string, candidateId: string): Promise<LabelledResult<CandidateView>>;
    approve(request: ApproveRequest): Promise<ApprovalOutcome>;
  };
  approvals: { get(approvalId: string): Promise<LabelledResult<ApprovalView>> };
  apply(request: ApplyRequest): Promise<PublicationOutcome>;
  status(operationId: string, expectedIntentDigest?: ContentDigest): Promise<PublicationStatus>;
  resolve(request: ResolveRequest): Promise<ResolveOutcome>;
  issueExecutionTicket(request: TicketRequest): Promise<TicketOutcome>;
  search(query: string): Promise<Listed<SearchHit>>;
  export(): AsyncIterable<ExportItem>;
  deferred: DeferredOperations;
}

/** The only object that can reach a project. Its principal is host-derived and read-only. */
export interface ProjectSession {
  readonly principal: PrincipalContext;
  readonly project: WikiProject;
  close(): Promise<void>;
}
