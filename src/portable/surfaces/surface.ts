/**
 * @file src/portable/surfaces/surface.ts
 * @description The one way a non-SDK surface (the viewer, MCP) reaches a
 * portable project.
 *
 * A surface is configured once with HOW to open a session — a project
 * reference and a transport credential — and nothing else. It holds no
 * principal, no role and no label. Every call opens a session through the same
 * chokepoint the SDK and CLI use and makes one operation, so each request is
 * authorized against current host state: a role removed a moment ago is gone
 * for the next request. Nothing a request carries can name who is acting or
 * what they may see, and there is no default administrator.
 */

import type { CandidateSummary, ProposalOutcome, PublicationStatus } from "../contracts.js";
import { PortableDenied, PortableRefusal } from "../errors.js";
import type {
  CandidateView, LabelledResult, Listed, PageListing, PageView, ProjectSession, SearchHit, WikiProject,
} from "../project/api.js";

/** Opens a fresh session for one request. Supplied by whoever configured the surface. */
export type OpenSession = () => Promise<ProjectSession>;

/** The read and propose operations a surface may offer. Approval and apply are not among them. */
export interface PortableSurface {
  listPages(): Promise<Listed<PageListing>>;
  readPage(id: string): Promise<LabelledResult<PageView>>;
  search(query: string): Promise<Listed<SearchHit>>;
  /** Allocate an operation id the CALLER keeps, before it submits anything. */
  allocateOperation(): Promise<string>;
  /** The recorded outcome of an operation, by the id the caller kept. */
  status(operationId: string): Promise<PublicationStatus>;
  /** Propose under a caller-held id. A retry passes the SAME id; nothing is allocated here. */
  propose(operationId: string, supersedes?: string): Promise<ProposalOutcome>;
  listCandidates(proposalOperationId: string): Promise<Listed<CandidateSummary>>;
  readCandidate(proposalOperationId: string, candidateId: string): Promise<LabelledResult<CandidateView>>;
}

/** Bind the surface operations to a way of opening sessions. */
export function portableSurface(open: OpenSession): PortableSurface {
  /** Open a session for ONE operation and close it afterwards, whatever happens. */
  const using = async <T>(operation: (project: WikiProject) => Promise<T>): Promise<T> => {
    const session = await open();
    try {
      return await operation(session.project);
    } finally {
      await session.close();
    }
  };
  return {
    listPages: () => using((project) => project.pages.list()),
    readPage: (id) => using((project) => project.pages.get(id)),
    search: (query) => using((project) => project.search(query)),
    allocateOperation: () => using((project) => project.allocateOperation()),
    status: (operationId) => using((project) => project.status(operationId)),
    propose: (operationId, supersedes) => using((project) => project.propose({ operationId, supersedes })),
    listCandidates: (proposalOperationId) => using((project) => project.candidates.list(proposalOperationId)),
    readCandidate: (proposalOperationId, candidateId) =>
      using((project) => project.candidates.get(proposalOperationId, candidateId)),
  };
}

/** What a surface tells a caller about a failure: a typed refusal, or nothing at all. */
export type SurfaceFailure = { kind: "refused"; code: string } | { kind: "not_found" };

/** Reduce any failure to what may be disclosed. Denied, absent and unexpected are one answer. */
export function surfaceFailure(error: unknown): SurfaceFailure {
  if (error instanceof PortableRefusal) return { kind: "refused", code: error.code };
  if (error instanceof PortableDenied) return { kind: "not_found" };
  return { kind: "not_found" };
}
