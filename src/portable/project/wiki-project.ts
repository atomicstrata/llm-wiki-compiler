/**
 * @file src/portable/project/wiki-project.ts
 * @description The host-side {@link WikiProject}: the one object through which
 * a session reaches a project.
 *
 * It is a thin facade on purpose. Each operation lives in its own module and
 * makes its own permission check against current host state; this file only
 * binds them to one session's runtime. It never falls back to the legacy path:
 * an operation outside the prototype vocabulary answers with a typed refusal.
 */

import { PortableDenied, PortableRefusal } from "../errors.js";
import { allocateOperationId } from "../host/operation-ids.js";
import { authorize } from "../host/policy.js";
import { issueTicket } from "../host/tickets.js";
import { holdsAtEffect } from "../authority/authority.js";
import { custodyOf } from "../authority/status.js";
import type { Deferred, DeferredOperations, ProjectSession, TicketOutcome, TicketRequest, WikiProject } from "./api.js";
import { apply } from "./apply.js";
import { propose } from "./propose.js";
import { exportProject } from "./export.js";
import { getPage, getSource, listPages, searchProject } from "./reads.js";
import { operationStatus, resolveOperation } from "./resolve.js";
import { approve, getApproval, getCandidate, listCandidates, loadVerifiedApproval } from "./review.js";
import type { ProjectRuntime } from "./runtime.js";
import { addSource } from "./sources.js";

/** The single answer of every deferred domain. */
const DEFERRED: Deferred = { kind: "refused", code: "operation_unsupported_on_portable_path" };
const deferred = async (): Promise<Deferred> => DEFERRED;

/** Every domain the prototype does not implement, each present only as a typed refusal. */
const DEFERRED_OPERATIONS: DeferredOperations = {
  downloadRawSource: deferred, trashSource: deferred, restoreSource: deferred, purgeSource: deferred,
  addRelation: deferred, transitionLifecycle: deferred, readHistory: deferred, publishDirect: deferred,
  relabel: deferred, exportLegacy: deferred,
};

/** Ask the host for a single-use ticket selecting one approved apply for one service. */
async function issueExecutionTicket(runtime: ProjectRuntime, request: TicketRequest): Promise<TicketOutcome> {
  await authorize(runtime.control, runtime.principal, "ticket.issue");
  await authorize(runtime.control, runtime.principal, "publication.apply");
  // Ticket changes pass through the same sequencer as publications.
  return runtime.store.withGate(async () => {
    // Decided again INSIDE the gate: a role revoked while this call waited is gone.
    if (!(await holdsAtEffect(runtime, runtime.principal, ["ticket.issue", "publication.apply"]))) {
      throw new PortableDenied();
    }
    const control = await runtime.control.loadProject(runtime.principal.project);
    if (control === null) throw new PortableDenied();
    const approval = await loadVerifiedApproval(runtime.store, request.approvalId).catch((error: unknown) => {
      if (error instanceof PortableRefusal) return null;
      throw error;
    });
    const stale = approval === null || approval.policyRevision !== control.policyRevision
      || Date.parse(approval.expiresAt) <= Date.now();
    if (stale) return { kind: "refused", code: "approval_invalid" };
    const custody = await custodyOf(runtime, request.approvalId);
    if (custody.state !== "available") return { kind: "refused", code: `approval_${custody.state}` };
    return { kind: "issued", ticket: await issueTicket(runtime, control, runtime.principal.subject, request) };
  });
}

/** Bind every prototype operation to one session's runtime. */
function createWikiProject(runtime: ProjectRuntime): WikiProject {
  return {
    id: runtime.principal.project,
    capabilities: async () => {
      await authorize(runtime.control, runtime.principal, "project.open");
      return runtime.store.capabilities;
    },
    allocateOperation: async () => {
      await authorize(runtime.control, runtime.principal, "project.open");
      return allocateOperationId(runtime.control, runtime.principal);
    },
    pages: { get: (id) => getPage(runtime, id), list: () => listPages(runtime) },
    sources: { get: (id) => getSource(runtime, id), add: (request) => addSource(runtime, request) },
    propose: (request) => propose(runtime, request),
    candidates: {
      list: (proposalOperationId) => listCandidates(runtime, proposalOperationId),
      get: (proposalOperationId, candidateId) => getCandidate(runtime, proposalOperationId, candidateId),
      approve: (request) => approve(runtime, request),
    },
    approvals: { get: (approvalId) => getApproval(runtime, approvalId) },
    apply: (request) => apply(runtime, request),
    status: (operationId, expected) => operationStatus(runtime, operationId, expected),
    resolve: (request) => resolveOperation(runtime, request),
    issueExecutionTicket: (request) => issueExecutionTicket(runtime, request),
    search: (query) => searchProject(runtime, query),
    export: () => exportProject(runtime),
    deferred: DEFERRED_OPERATIONS,
  };
}

/** A session over `runtime`. Closing it releases nothing: it holds no authority. */
export function createProjectSession(runtime: ProjectRuntime): ProjectSession {
  return { principal: runtime.principal, project: createWikiProject(runtime), close: async () => undefined };
}
