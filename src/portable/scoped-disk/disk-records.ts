/**
 * @file src/portable/scoped-disk/disk-records.ts
 * @description The records a disk scoped proposal stores, how they are loaded
 * back, and the canonical source entries an apply of it establishes.
 *
 * A disk proposal's dependency and coverage records live at their own paths,
 * beside its V1-shaped plan and candidates, and never at the V1 or S2a
 * read-set path: neither of those loaders can adopt one, and this loader
 * adopts neither of theirs.
 *
 * An entry is a pure function of the proposal's committed candidates and
 * coverage, the pages the apply wrote, and the proposal's own commit time. It
 * is established only for a source the proposal covered COMPLETELY and whose
 * every page this apply wrote; every other entry of the canonical state —
 * including a newer legacy write, attestations and kept-page decisions — is
 * carried over exactly as it is now.
 */

import { applySourceState } from "../../utils/state.js";
import type { SourceState, WikiState } from "../../utils/types.js";
import { PROPOSALS_PREFIX } from "../logical-paths.js";
import type { VerifiedProposalOf } from "../project/proposal-records.js";
import { loadCommittedRecord, loadProtocolProposal } from "../scoped/scoped-review.js";
import { completedSources } from "../scoped/source-records.js";
import type { ReadView } from "../store/store.js";
import { DISK_SCOPED_PROTOCOL_V2, type DiskScopedCoverageV2, type DiskScopedDependenciesV2 } from "./disk-contracts.js";

/** A disk scoped proposal as review and apply load it. */
export type DiskScopedProposal = VerifiedProposalOf<DiskScopedDependenciesV2>;

/** The disk scoped records of one proposal. Never the V1 or S2a read-set. */
export function diskProposalPaths(proposalOperationId: string): { readSet: string; coverage: string } {
  const base = `${PROPOSALS_PREFIX}${proposalOperationId}/`;
  return { readSet: `${base}disk-scoped-read-set`, coverage: `${base}disk-scoped-coverage` };
}

/** Load a committed disk scoped proposal by its own records; anything else is `candidate_drift`, never adopted. */
export function loadDiskProposal(view: ReadView, proposalOperationId: string): Promise<DiskScopedProposal> {
  return loadProtocolProposal<DiskScopedDependenciesV2>(view, proposalOperationId, diskProposalPaths(proposalOperationId).readSet, DISK_SCOPED_PROTOCOL_V2);
}

/** A disk proposal's coverage record, re-hashed against the digest its commit receipt recorded. */
export function loadDiskCoverage(view: ReadView, proposalOperationId: string): Promise<DiskScopedCoverageV2> {
  return loadCommittedRecord<DiskScopedCoverageV2>(view, proposalOperationId, diskProposalPaths(proposalOperationId).coverage);
}

/** The entries an apply of `proposal` establishes, given the pages it wrote. */
export function establishedEntries(
  proposal: DiskScopedProposal, coverage: DiskScopedCoverageV2, written: ReadonlySet<string>, compiledAt: string,
): Record<string, SourceState> {
  const entries: Record<string, SourceState> = {};
  for (const { source, hash, slugs } of completedSources(proposal.candidates, coverage.complete, written)) {
    entries[source] = { hash, concepts: [...new Set(slugs)].sort(), compiledAt };
  }
  return entries;
}

/** The canonical state with `entries` merged in, every other entry and decision untouched. Attestations survive. */
export function mergedState(current: WikiState, entries: Readonly<Record<string, SourceState>>): WikiState {
  const state: WikiState = { ...current, sources: { ...current.sources } };
  for (const [source, entry] of Object.entries(entries)) applySourceState(state, source, entry);
  return state;
}
