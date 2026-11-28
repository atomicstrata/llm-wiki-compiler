/**
 * @file src/portable/project/apply.ts
 * @description `candidate.apply`: execute one approved publication.
 *
 * An approval authorizes ONE committed apply. It is reserved when an apply
 * naming it is accepted and is consumed with that apply's receipt, so a second
 * apply is refused even if every target has returned to its expected pre-image.
 *
 * Before anything is written, and in one hold of the gate, the host re-checks
 * everything against CURRENT state: the approval's validity, the approver's and
 * the applier's authority, the stored proposal and approval bytes (re-hashed),
 * every semantic input the proposal depended on, and the content floor. It then
 * writes exactly the bytes whose digest was approved — or nothing.
 */

import { COMPILE_ORIGIN } from "../../trust/checks.js";
import { runContentFloor } from "../../trust/content-floor.js";
import { intentDigestOf, runOperation, type ResolvedPublication, type RunGuards } from "../authority/authority.js";
import { custodyOf } from "../authority/status.js";
import type {
  ApprovalRecordV1, LabelSet, OperationIdentityRecordV1, PublicationOutcome, RefusalCode, SkippedItem,
} from "../contracts.js";
import { normalizeLabels } from "../digest.js";
import { PortableDenied, PortableRefusal } from "../errors.js";
import type { ProjectControlRecord } from "../host/control.js";
import { authorize, entitlementOf } from "../host/policy.js";
import { ticketCustodyKey, ticketForApply } from "../host/tickets.js";
import type { ProjectStore, StoredWrite, TailWrite } from "../store/store.js";
import type { ApplyRequest } from "./api.js";
import type { VerifiedCandidate, VerifiedProposalOf } from "./proposal-records.js";
import { loadVerifiedApproval, V1_PROPOSAL_VERIFIER, type ProposalVerifier } from "./review.js";
import { v1WriteRefusal } from "./propose.js";
import type { ProjectRuntime } from "./runtime.js";
import { clearedWriteFloor } from "./label-floor.js";
import { applyTail } from "./tail.js";

/** Subjects that authenticate as a service rather than a person. */
const SERVICE_PREFIX = "service:";

/** What an apply publishes beside its pages: further authoritative writes, and derived tail objects. */
export interface ApplyCompanions { writes: StoredWrite[]; tail: TailWrite[] }

/**
 * How one proposal path applies: how its proposals are loaded and validated,
 * and what is published beside the approved pages. The approval, custody,
 * delegation, floor and commit protocol is the same for every path.
 */
export interface ApplyPath<D = unknown> {
  verifier: ProposalVerifier<D>;
  /** A refusal this path makes before anything is reserved or read, or `null` to proceed. */
  admit?(runtime: ProjectRuntime): Promise<RefusalCode | null>;
  companions(
    store: ProjectStore, proposal: VerifiedProposalOf<D>, pages: readonly StoredWrite[],
    applied: readonly VerifiedCandidate[], labels: readonly string[], context: ApplyContext,
  ): Promise<ApplyCompanions>;
  /**
   * The label floor a write of `path` keeps, after requiring the applier to be
   * cleared for it. Absent, the shared {@link clearedWriteFloor}.
   */
  writeFloor?(runtime: ProjectRuntime, path: string): Promise<LabelSet>;
  /** Refusal-only guards this path's apply passes to the authority. Absent, none. */
  runGuards?(): RunGuards;
}

/** Which apply a companion record belongs to. */
export interface ApplyContext { operationId: string; approvalId: string }

/** Version 1: the index, the MOC and compile state are rebuilt whole as the tail. */
const V1_APPLY_PATH: ApplyPath = {
  verifier: V1_PROPOSAL_VERIFIER as ProposalVerifier,
  // An adopted (format-2) project keeps one authoritative state home: the V1 tail would bypass it.
  admit: v1WriteRefusal,
  companions: async (store, _proposal, pages, applied, labels) => ({
    writes: [], tail: await applyTail(store, pages, applied.map((entry) => entry.candidate), labels),
  }),
};

/** The approval, required to be valid under current policy. */
async function usableApproval(
  runtime: ProjectRuntime, control: ProjectControlRecord, approvalId: string,
): Promise<ApprovalRecordV1> {
  const approval = await loadVerifiedApproval(runtime.store, approvalId);
  if (approval === null) throw new PortableRefusal("approval_invalid");
  const expired = Date.parse(approval.expiresAt) <= Date.now();
  // Conservative invalidation: ANY base-policy change after approval requires reapproval (D11).
  const policyMoved = approval.policyRevision !== control.policyRevision;
  const approverRevoked = !entitlementOf(control, approval.approver).permissions.has("candidate.approve");
  if (expired || policyMoved || approverRevoked) throw new PortableRefusal("approval_invalid");
  const custody = await custodyOf(runtime, approvalId);
  if (custody.state === "reserved") throw new PortableRefusal("approval_reserved");
  if (custody.state === "consumed") throw new PortableRefusal("approval_consumed");
  return approval;
}

/** Who this apply runs on behalf of, and the ticket it uses, if it is delegated. */
async function delegationFor(
  runtime: ProjectRuntime, control: ProjectControlRecord, request: ApplyRequest,
): Promise<{ onBehalfOf: string[]; ticketId: string | null }> {
  const isService = runtime.principal.actor.startsWith(SERVICE_PREFIX);
  if (!isService) {
    if (request.ticketId !== undefined) throw new PortableRefusal("ticket_invalid");
    return { onBehalfOf: [], ticketId: null };
  }
  const ticket = await ticketForApply(runtime, control, runtime.principal, request.ticketId, request.approvalId);
  return { onBehalfOf: [ticket.applier], ticketId: ticket.ticketId };
}

/** Take the approval (and ticket) for this operation; custody then follows its outcome. */
async function reserve(
  runtime: ProjectRuntime, identity: OperationIdentityRecordV1, approvalId: string, ticketId: string | null,
): Promise<void> {
  await runtime.store.putReservation(approvalId, identity.operationId);
  if (ticketId !== null) await runtime.store.putReservation(ticketCustodyKey(ticketId), identity.operationId);
  await runtime.store.putIdentity({ ...identity, holds: { approvalId, ticketId } });
}

/** The proposal an approval binds, required to still be byte-identical to what was approved. */
async function approvedProposal(
  runtime: ProjectRuntime, approval: ApprovalRecordV1, verifier: ProposalVerifier,
): Promise<VerifiedProposalOf<unknown>> {
  const proposal = await verifier.load(runtime.store, approval.proposalOperationId).catch((error: unknown) => {
    if (error instanceof PortableDenied) throw new PortableRefusal("candidate_drift", "proposal missing");
    throw error;
  });
  const { receipt } = proposal;
  const matches = receipt.candidateSetDigest === approval.candidateSetDigest
    && receipt.planDigest === approval.planDigest
    && receipt.applyDependenciesDigest === approval.applyDependenciesDigest;
  if (!matches) throw new PortableRefusal("candidate_drift");
  return proposal;
}

/** One page write for an approved candidate, or the reason the floor skipped it. */
async function pageWrite(entry: VerifiedCandidate, labels: readonly string[]): Promise<StoredWrite | SkippedItem> {
  const existingChars = entry.target.pre.state === "present" ? entry.target.pre.byteCount : 0;
  // The planner floor is re-asserted HERE, in the host, on every adapter.
  const floor = await runContentFloor({
    directory: "concepts", slug: entry.candidate.slug, body: entry.candidate.body,
    origin: COMPILE_ORIGIN, existingChars,
  });
  if (!floor.allowed) return { path: entry.target.path, code: "floor_blocked" };
  return { path: entry.target.path, bytes: Buffer.from(entry.candidate.body, "utf8"), pre: entry.target.pre, labels };
}

/** Each approved candidate's page write under its target's floor, or the reason the floor skipped it. */
async function candidateWrites(
  runtime: ProjectRuntime, proposal: VerifiedProposalOf<unknown>, approval: ApprovalRecordV1, path: ApplyPath,
): Promise<{ writes: StoredWrite[]; skipped: SkippedItem[]; applied: VerifiedCandidate[] }> {
  const writes: StoredWrite[] = [];
  const skipped: SkippedItem[] = [...proposal.plan.skipped];
  const applied: VerifiedCandidate[] = [];
  for (const entry of proposal.candidates) {
    // A target that retains stricter labels keeps them, and only an applier cleared for them may write it.
    const floor = await (path.writeFloor?.(runtime, entry.target.path) ?? clearedWriteFloor(runtime, entry.target.path, "publication.apply"));
    const result = await pageWrite(entry, floor.length === 0 ? approval.labels : normalizeLabels([...approval.labels, ...floor]));
    if ("bytes" in result) { writes.push(result); applied.push(entry); } else skipped.push(result);
  }
  return { writes, skipped, applied };
}

/** Resolve the apply under the gate. Throws a refusal; writes nothing itself. */
async function resolveApply(
  runtime: ProjectRuntime, request: ApplyRequest, identity: OperationIdentityRecordV1, path: ApplyPath,
): Promise<ResolvedPublication> {
  const refusal = (await path.admit?.(runtime)) ?? null;
  if (refusal !== null) throw new PortableRefusal(refusal, "this project's format does not accept this apply");
  const control = await runtime.control.loadProject(runtime.principal.project);
  if (control === null) throw new PortableDenied();
  const approval = await usableApproval(runtime, control, request.approvalId);
  const { onBehalfOf, ticketId } = await delegationFor(runtime, control, request);
  await reserve(runtime, identity, request.approvalId, ticketId);
  const proposal = await approvedProposal(runtime, approval, path.verifier);
  await path.verifier.validate(runtime.store, proposal);
  const { writes, skipped, applied } = await candidateWrites(runtime, proposal, approval, path);
  if (writes.length === 0) throw new PortableRefusal("floor_blocked");
  const context = { operationId: identity.operationId, approvalId: request.approvalId };
  const companions = await path.companions(runtime.store, proposal, writes, applied, approval.labels, context);
  return {
    writes: [...writes, ...companions.writes], skipped, onBehalfOf, tail: companions.tail,
    policyFence: { policyRevision: control.policyRevision, ticketRevision: control.ticketRevision },
    consumedApprovalId: request.approvalId, consumedTicketId: ticketId,
  };
}

/** Apply one approved candidate set. */
export async function apply(
  runtime: ProjectRuntime, request: ApplyRequest, path: ApplyPath = V1_APPLY_PATH,
): Promise<PublicationOutcome> {
  // For a service this checks the service's OWN preexisting grant.
  await authorize(runtime.control, runtime.principal, "publication.apply");
  const supersedes = request.supersedes ?? null;
  const payload = { approvalId: request.approvalId, ticketId: request.ticketId ?? null };
  const operation = {
    operationId: request.operationId, kind: "candidate.apply" as const, supersedes, requires: ["publication.apply" as const],
    intentDigest: intentDigestOf(runtime.principal, "candidate.apply", request.operationId, supersedes, payload),
  };
  const outcome = await runOperation(
    runtime, runtime.principal, operation, (identity) => resolveApply(runtime, request, identity, path), undefined, path.runGuards?.(),
  );
  return outcome as PublicationOutcome;
}
