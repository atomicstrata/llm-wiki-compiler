/**
 * @file src/portable/scoped/source-records.ts
 * @description The narrow durable completion record of one source: how it is
 * parsed, and how it is derived from a proposal's retained evidence.
 *
 * A record is a pure function of retained evidence — the proposal's committed
 * candidate records and coverage, the namespace it declared, and the
 * proposal's own commit time — and of which pages the apply actually wrote.
 * So the apply that establishes a record and a later restoration of a lost
 * one compute the same bytes, and a restoration is checked against the digest
 * the establishing receipt recorded before anything is bound.
 */

import { recordBytes } from "../digest.js";
import type { LabelSet } from "../contracts.js";
import type { StoredWrite } from "../store/store.js";
import type { ReadView } from "../store/store.js";
import type { VerifiedCandidate, VerifiedProposalOf } from "../project/proposal-records.js";
import type { ScopedCoverageV2, ScopedDependenciesV2, ScopedSourceRecordV2 } from "./contracts.js";
import { namespacedPagePath, sourceRecordPath } from "./namespaces.js";

/** Parse a durable record's text, or `null` when it is not one. */
export function parseSourceRecord(text: string): ScopedSourceRecordV2 | null {
  try {
    const record = JSON.parse(text) as ScopedSourceRecordV2;
    const isRecord = typeof record.source === "string" && typeof record.namespace === "string" && Array.isArray(record.concepts);
    return isRecord ? record : null;
  } catch {
    return null;
  }
}

/** A scoped proposal as review and apply load it. */
export type ScopedProposal = VerifiedProposalOf<ScopedDependenciesV2>;

/** One source an apply completes: its compiled hash, the concept slugs it owns, and the modifiers it ran under. */
export interface CompletedSource { source: string; hash: string; slugs: string[]; promptModifiers: string }

/**
 * The sources an apply completes, given the pages it wrote: each `complete`
 * source whose every page in this proposal was written. Shared by every
 * scoped path, so what "completed" means cannot drift between stores.
 */
export function completedSources(
  candidates: readonly VerifiedCandidate[], complete: readonly string[], written: ReadonlySet<string>,
): CompletedSource[] {
  const completed: CompletedSource[] = [];
  for (const source of complete) {
    const mine = candidates.filter((entry) => entry.candidate.sources.includes(source));
    if (mine.length === 0 || mine.some((entry) => !written.has(entry.target.path))) continue;
    const state = mine[0].candidate.sourceStates?.[source];
    if (state === undefined) continue;
    const slugs = state.concepts.length > 0 ? [...state.concepts] : mine.map((entry) => entry.candidate.slug);
    completed.push({ source, hash: state.hash, slugs, promptModifiers: mine[0].candidate.promptModifiers ?? "" });
  }
  return completed;
}
