/**
 * @file src/portable/project/review.ts
 * @description Review of a proposal and `approval.record`.
 *
 * Review is of the real thing. A reviewer is served the exact final rendered
 * page that would be written and the exact version it would replace, and the
 * stored bytes are re-hashed every time a view is served. An approval then
 * names the candidate-set, plan and dependency digests the reviewer saw; ids
 * alone are not accepted, and any difference from the recorded proposal is
 * `candidate_drift` with nothing recorded.
 *
 * An approval is itself an operation: it has a pre-allocated id, the same
 * outcome arms and the same recovery as an apply. It changes no curated
 * content; the record is authoritative state all the same.
 */

import { intentDigestOf, runOperation, type ResolvedPublication, type RunGuards } from "../authority/authority.js";
import { custodyOf } from "../authority/status.js";
import { validateDependencies } from "../authority/validate.js";
import {
  ACCESS_NOTICE, type ApprovalOutcome, type ApprovalRecordV1, type CandidateSummary,
  type LabelSet, type OperationIdentityRecordV1, type ReceiptV1,
} from "../contracts.js";
import { bytesDigest, recordBytes } from "../digest.js";
import { PortableDenied, PortableRefusal } from "../errors.js";
import { authorize, isVisible } from "../host/policy.js";
import { approvalPath } from "../logical-paths.js";
import type { ProjectStore, ReadView } from "../store/store.js";
import type { ApprovalView, ApproveRequest, CandidateView, LabelledResult, Listed } from "./api.js";
import {
  loadVerifiedProposal, type VerifiedCandidate, type VerifiedProposal, type VerifiedProposalOf,
} from "./proposal-records.js";
import { withProjectRead } from "./reads.js";
import type { ProjectRuntime } from "./runtime.js";

/**
 * How one proposal path loads its proposals and re-validates their
 * dependencies. Review and apply are the same protocol for every path; only
 * the dependency record and its validation differ.
 */
export interface ProposalVerifier<D = unknown> {
  load(view: ReadView, proposalOperationId: string): Promise<VerifiedProposalOf<D>>;
  /** @throws PortableRefusal when any dependency is no longer what generation saw. */
  validate(store: ProjectStore, proposal: VerifiedProposalOf<D>): Promise<void>;
  /**
   * The labels an approval of `proposal` carries, and so every page an apply
   * of it writes. Omitted, they are the project compartment, as version 1 has
   * always recorded. A path whose proposals carry a wider union says so here.
   */
  approvalLabels?(proposal: VerifiedProposalOf<D>): readonly string[];
  /**
   * When present, REPLACES the version 1 visibility check of this path's
   * proposals, candidates and approvals: asked with the committed labels before
   * any stored body is read. Absent, the check is exactly version 1's.
   */
  isReaderCleared?(labels: LabelSet): Promise<boolean>;
  /** Refusal-only guards an approval of this path's proposals passes to the authority. Absent, none. */
  runGuards?(): RunGuards;
  /**
   * When present, the view an approval's stored record is read through once
   * its reader is cleared: a path whose authority can move between that
   * clearance and the read says so here. Absent, the read view itself.
   */
  guardView?(view: ReadView): ReadView;
}

/** Whether the principal may read objects with `labels` on `verifier`'s path: its own check, else version 1's. */
function isReaderCleared(runtime: ProjectRuntime, verifier: ProposalVerifier, labels: LabelSet): Promise<boolean> {
  return verifier.isReaderCleared?.(labels) ?? isVisible(runtime.control, runtime.principal, "candidate.read", labels);
}

/** The version 1 path: the V1 read-set, validated as version 1 always has. */
export const V1_PROPOSAL_VERIFIER: ProposalVerifier<VerifiedProposal["dependencies"]> = {
  load: loadVerifiedProposal,
  validate: (store, proposal) => validateDependencies(store, proposal.dependencies),
};

/**
 * Load a proposal for a reader, in one consistent view.
 *
 * The principal is authorized against the proposal's COMMITTED labels, taken
 * from its commit receipt, before any stored candidate body is read: a reader
 * who is not cleared never causes protected bytes to be loaded at all.
 *
 * @returns `null` when there is no such proposal the principal may know of.
 */
async function proposalForReader(
  runtime: ProjectRuntime, proposalOperationId: string, verifier: ProposalVerifier,
): Promise<VerifiedProposalOf<unknown> | null> {
  await authorize(runtime.control, runtime.principal, "candidate.read");
  return withProjectRead(runtime, async (view) => {
    const commit = await view.getReceipt(proposalOperationId);
    if (commit === null || commit.proposal === undefined) return null;
    const labels = commit.published[0]?.labels ?? [];
    if (!(await isReaderCleared(runtime, verifier, labels))) return null;
    return verifier.load(view, proposalOperationId);
  });
}

/** List a proposal's candidates. A listing aid only: never enough to approve from. */
export async function listCandidates(
  runtime: ProjectRuntime, proposalOperationId: string, verifier: ProposalVerifier = V1_PROPOSAL_VERIFIER,
): Promise<Listed<CandidateSummary>> {
  const proposal = await proposalForReader(runtime, proposalOperationId, verifier);
  const items: CandidateSummary[] = [];
  for (const entry of proposal?.candidates ?? []) {
    if (await isReaderCleared(runtime, verifier, entry.summary.labels)) {
      items.push(entry.summary);
    }
  }
  return { items, notice: ACCESS_NOTICE };
}

/** The full view of one verified candidate. */
function viewOf(proposal: VerifiedProposalOf<unknown>, entry: VerifiedCandidate): CandidateView {
  return {
    id: entry.candidate.id,
    proposalOperationId: proposal.receipt.operationId,
    targetPath: entry.target.path,
    targetPre: entry.target.pre,
    draftBody: entry.candidate.body,
    draftDigest: entry.draftDigest,
    candidateDigest: entry.summary.candidateDigest,
    labels: entry.summary.labels,
    candidateSetDigest: proposal.receipt.candidateSetDigest,
    planDigest: proposal.receipt.planDigest,
    applyDependenciesDigest: proposal.receipt.applyDependenciesDigest,
  };
}

/** Read one candidate in full, body included, re-hashed from its stored bytes. */
export async function getCandidate(
  runtime: ProjectRuntime, proposalOperationId: string, candidateId: string,
  verifier: ProposalVerifier = V1_PROPOSAL_VERIFIER,
): Promise<LabelledResult<CandidateView>> {
  const proposal = await proposalForReader(runtime, proposalOperationId, verifier);
  const entry = proposal?.candidates.find((candidate) => candidate.candidate.id === candidateId);
  if (!proposal || !entry) return { visible: false };
  if (!(await isReaderCleared(runtime, verifier, entry.summary.labels))) {
    return { visible: false };
  }
  return { visible: true, value: viewOf(proposal, entry), labels: entry.summary.labels };
}

/** The approval's expiry: the caller's request, capped by the host. */
function cappedExpiry(requested: string, maxTtlMs: number): string {
  const ceiling = Date.now() + maxTtlMs;
  const asked = Date.parse(requested);
  return new Date(Number.isFinite(asked) ? Math.min(asked, ceiling) : ceiling).toISOString();
}

/** The proposal an approve request names, or `candidate_drift` when it does not match. */
async function proposalForApproval(
  runtime: ProjectRuntime, request: ApproveRequest, verifier: ProposalVerifier,
): Promise<VerifiedProposalOf<unknown>> {
  const proposal = await verifier.load(runtime.store, request.proposalOperationId).catch((error: unknown) => {
    if (error instanceof PortableDenied) throw new PortableRefusal("candidate_drift", "no such proposal");
    throw error;
  });
  const { receipt } = proposal;
  const matches = receipt.candidateSetDigest === request.candidateSetDigest
    && receipt.planDigest === request.planDigest
    && receipt.applyDependenciesDigest === request.applyDependenciesDigest;
  if (!matches) throw new PortableRefusal("candidate_drift", "reviewed digests do not match the proposal");
  return proposal;
}

/** Resolve an approval under the gate: verify the proposal, its currency, and build the record. */
async function resolveApproval(
  runtime: ProjectRuntime, request: ApproveRequest, identity: OperationIdentityRecordV1, verifier: ProposalVerifier,
): Promise<ResolvedPublication> {
  const control = await runtime.control.loadProject(runtime.principal.project);
  if (control === null) throw new PortableDenied();
  const proposal = await proposalForApproval(runtime, request, verifier);
  await verifier.validate(runtime.store, proposal);
  const approval: ApprovalRecordV1 = {
    approvalId: `apr_${identity.operationId.slice("op_".length)}`,
    tenant: control.tenant, project: control.projectId, operationId: identity.operationId,
    proposalOperationId: request.proposalOperationId, candidateSetDigest: request.candidateSetDigest,
    planDigest: request.planDigest, applyDependenciesDigest: request.applyDependenciesDigest,
    approver: runtime.principal.subject, proposer: proposal.proposer, policyRevision: control.policyRevision,
    labels: [...(verifier.approvalLabels?.(proposal) ?? [control.compartment])], createdAt: new Date().toISOString(),
    expiresAt: cappedExpiry(request.requestedExpiresAt, runtime.control.limits.maxApprovalTtlMs),
  };
  const write = {
    path: approvalPath(approval.approvalId), bytes: recordBytes(approval),
    pre: { state: "absent" as const }, labels: approval.labels,
  };
  return {
    writes: [write], tail: [], skipped: [], onBehalfOf: [], approval,
    policyFence: { policyRevision: control.policyRevision, ticketRevision: control.ticketRevision },
    consumedApprovalId: null, consumedTicketId: null,
  };
}

/** Record an approval of exactly the candidate set, plan and dependencies that were reviewed. */
export async function approve(
  runtime: ProjectRuntime, request: ApproveRequest, verifier: ProposalVerifier = V1_PROPOSAL_VERIFIER,
): Promise<ApprovalOutcome> {
  await authorize(runtime.control, runtime.principal, "candidate.approve");
  await authorize(runtime.control, runtime.principal, "candidate.read");
  const supersedes = request.supersedes ?? null;
  const payload = {
    proposalOperationId: request.proposalOperationId, candidateSetDigest: request.candidateSetDigest,
    planDigest: request.planDigest, applyDependenciesDigest: request.applyDependenciesDigest,
    requestedExpiresAt: request.requestedExpiresAt,
  };
  const operation = {
    operationId: request.operationId, kind: "approval.record" as const, supersedes,
    requires: ["candidate.approve" as const, "candidate.read" as const],
    intentDigest: intentDigestOf(runtime.principal, "approval.record", request.operationId, supersedes, payload),
  };
  const outcome = await runOperation(
    runtime, runtime.principal, operation, (identity) => resolveApproval(runtime, request, identity, verifier), undefined, verifier.runGuards?.(),
  );
  return outcome as ApprovalOutcome;
}

/**
 * Load an approval record from the authority's ledger and require its stored
 * bytes to still match what was committed.
 *
 * @returns `null` when no such committed approval exists.
 * @throws PortableRefusal `candidate_drift` when the stored record was changed.
 */
export async function loadVerifiedApproval(store: ReadView, approvalId: string): Promise<ApprovalRecordV1 | null> {
  const committed = await committedApproval(store, approvalId);
  if (committed === null) return null;
  const { commit } = committed;
  const stored = await store.read(approvalPath(approvalId));
  if (stored === null || bytesDigest(stored) !== commit.published[0]?.digest) {
    throw new PortableRefusal("candidate_drift", "approval record");
  }
  return committed.approval;
}

/** The approval as its commit receipt recorded it, without reading the stored record. */
async function committedApproval(
  store: ReadView, approvalId: string,
): Promise<{ commit: ReceiptV1; approval: ApprovalRecordV1 } | null> {
  if (!approvalId.startsWith("apr_")) return null;
  const commit = await store.getReceipt(`op_${approvalId.slice("apr_".length)}`);
  if (commit === null || commit.approval === undefined || commit.approval.approvalId !== approvalId) return null;
  return { commit, approval: commit.approval };
}

/**
 * Inspect the approval a handoff names: its immutable subject bindings and its
 * current custody. Reading it grants no authority to apply.
 */
export async function getApproval(
  runtime: ProjectRuntime, approvalId: string, verifier: ProposalVerifier = V1_PROPOSAL_VERIFIER,
): Promise<LabelledResult<ApprovalView>> {
  await authorize(runtime.control, runtime.principal, "candidate.read");
  const record = await withProjectRead(runtime, async (view) => {
    // Authorized on the committed labels BEFORE the stored record is read.
    const committed = await committedApproval(view, approvalId);
    if (committed === null) return null;
    const cleared = await isReaderCleared(runtime, verifier, committed.approval.labels);
    return cleared ? loadVerifiedApproval(verifier.guardView?.(view) ?? view, approvalId) : null;
  });
  if (record === null) return { visible: false };
  return { visible: true, value: { record, custody: await custodyOf(runtime, approvalId) }, labels: record.labels };
}
