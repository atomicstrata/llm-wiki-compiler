/**
 * @file src/portable/scoped/scoped-review.ts
 * @description How review and apply load, validate and complete a scoped
 * proposal: the hooks the shared review and apply protocol takes.
 *
 * Every load re-checks, inside the gate and before any proposal byte is read,
 * that the caller is bound to this tenant, project and store, holds the verbs
 * of the act, and is cleared for every label the proposal carries — the union
 * of everything its generation consumed. An approval carries that union, so
 * every page and record an apply writes carries it too.
 *
 * Apply publishes the approved pages plus the narrow completion records of the
 * sources it completes. It publishes no index, MOC or compile-state object:
 * those are views on this store.
 */

import type { Permission } from "../contracts.js";
import { PortableRefusal } from "../errors.js";
import type { ApplyPath } from "../project/apply.js";
import { loadVerifiedProposalWith, readVerifiedRecord, type VerifiedProposalOf } from "../project/proposal-records.js";
import type { ProposalVerifier } from "../project/review.js";
import type { ProjectRuntime } from "../project/runtime.js";
import type { ReadView } from "../store/store.js";
import { SCOPED_PROTOCOL_V2, type ScopedCoverageV2, type ScopedDependenciesV2 } from "./contracts.js";
import { scopedProposalPaths } from "./namespaces.js";
import { requireScopedAuthority } from "./scoped-authority.js";
import type { ScopedStoreSurface } from "./store-types.js";
import { validateScopedDependencies } from "./scoped-validate.js";
import type { ScopedProposal } from "./source-records.js";

/**
 * Load a committed proposal of one protocol by its own dependency record at
 * `path`; a proposal of any other path or protocol is `candidate_drift`, never adopted.
 */
export async function loadProtocolProposal<D extends { protocol: string }>(
  view: ReadView, proposalOperationId: string, path: string, protocol: D["protocol"],
): Promise<VerifiedProposalOf<D>> {
  const proposal = await loadVerifiedProposalWith<D>(view, proposalOperationId, path);
  if (proposal.dependencies.protocol !== protocol) throw new PortableRefusal("candidate_drift", `not a ${protocol} proposal`);
  return proposal;
}

/** One further record a proposal's commit published at `path`, re-hashed against the digest its receipt recorded. */
export async function loadCommittedRecord<T>(view: ReadView, proposalOperationId: string, path: string): Promise<T> {
  const digest = (await view.getReceipt(proposalOperationId))?.published.find((object) => object.path === path)?.digest;
  if (digest === undefined) throw new PortableRefusal("candidate_drift", path);
  return readVerifiedRecord<T>(view, path, digest);
}

/**
 * Load a proposal for an act: the caller is re-checked for the verbs, then
 * cleared for the proposal's COMMITTED labels before any stored record is read.
 */
export async function clearedLoad<P>(
  runtime: ProjectRuntime, verbs: readonly Permission[], view: ReadView, proposalOperationId: string,
  load: (view: ReadView, proposalOperationId: string) => Promise<P>,
): Promise<P> {
  await requireScopedAuthority(runtime, verbs);
  const commit = await view.getReceipt(proposalOperationId);
  await requireScopedAuthority(runtime, verbs, commit?.published[0]?.labels ?? []);
  return load(view, proposalOperationId);
}

/** Load a committed scoped proposal by its own records; anything else is `candidate_drift`, never adopted. */
function loadScopedProposal(view: ReadView, proposalOperationId: string): Promise<ScopedProposal> {
  return loadProtocolProposal<ScopedDependenciesV2>(view, proposalOperationId, scopedProposalPaths(proposalOperationId).readSet, SCOPED_PROTOCOL_V2);
}

/** A scoped proposal's coverage record, re-hashed against the digest its commit receipt recorded. */
function loadCoverage(view: ReadView, proposalOperationId: string): Promise<ScopedCoverageV2> {
  return loadCommittedRecord<ScopedCoverageV2>(view, proposalOperationId, scopedProposalPaths(proposalOperationId).coverage);
}

/** The scoped proposal path for one act, re-checking binding, verbs and clearance at every load and validation. */
function scopedVerifier(
  runtime: ProjectRuntime, store: ScopedStoreSurface, verbs: readonly Permission[],
): ProposalVerifier<ScopedDependenciesV2> {
  return {
    load: (view, proposalOperationId) => clearedLoad(runtime, verbs, view, proposalOperationId, loadScopedProposal),
    validate: async (_store, proposal) => {
      await requireScopedAuthority(runtime, verbs, proposal.labels);
      await validateScopedDependencies(store, proposal.dependencies);
    },
    approvalLabels: (proposal) => proposal.labels,
  };
}
