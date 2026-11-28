/**
 * @file src/portable/scoped-disk/custody.ts
 * @description The format-2 state-custody record of a registered directory:
 * which canonical `state.json` source entries were OBSERVED at adoption, and
 * which entries a later scoped apply ESTABLISHED.
 *
 * It is retained evidence and a loss detector, never a second source-state
 * home. `.llmwiki/state.json` stays canonical beside every legacy writer:
 *
 * - an entry present in `state.json` is canonical whatever custody says — a
 *   newer legacy write is a legitimate decision and custody never overrides it;
 * - an entry custody knows that has DISAPPEARED is unknown and dirty: nothing
 *   tells a legitimate removal from a loss, so generation over that source
 *   refuses rather than spend a model call on a reset;
 * - an entry neither knows is simply not compiled yet.
 *
 * The record is published as an authoritative target of the same intent and
 * receipt as the pages and `state.json` it describes, never as a tail.
 */

import type { ContentDigest } from "../contracts.js";
import { recordDigest } from "../digest.js";
import type { SourceState, WikiState } from "../../utils/types.js";

/** What custody knows about one source's canonical entry. */
export interface CustodyEntryV2 {
  /** Digest of the entry as observed or established. */
  entryDigest: ContentDigest;
  /** `adoption`, or the scoped proposal whose apply established it. */
  establishedBy: string;
}

/** The custody record of one adopted project. */
export interface StateCustodyV2 {
  kind: "llmwiki-state-custody";
  version: 2;
  project: string;
  entries: Readonly<Record<string, CustodyEntryV2>>;
}

/** How one source's canonical entry stands against custody. */
type EntryStanding = "present" | "never-known" | "lost";

/** The digest of one canonical source entry: what a state-entry dependency names. */
export function entryDigestOf(entry: SourceState | undefined): ContentDigest | "absent" {
  return entry === undefined ? "absent" : recordDigest(entry);
}

/** The custody baseline of `state` at adoption: every entry it holds, observed. */
export function custodyBaseline(project: string, state: WikiState): StateCustodyV2 {
  const entries: Record<string, CustodyEntryV2> = {};
  for (const [source, entry] of Object.entries(state.sources)) {
    entries[source] = { entryDigest: recordDigest(entry), establishedBy: "adoption" };
  }
  return { kind: "llmwiki-state-custody", version: 2, project, entries };
}

/** True for a plain (non-array) object. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when every retained entry carries its digest and the operation that established it. */
function entriesWellFormed(entries: Record<string, unknown>): boolean {
  return Object.values(entries).every((entry) => isPlainRecord(entry)
    && typeof entry.entryDigest === "string" && entry.entryDigest.startsWith("sha256:") && typeof entry.establishedBy === "string");
}

/** Parse a custody record, or `null` when it is malformed or names another project. */
export function parseCustody(text: string, project: string): StateCustodyV2 | null {
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    return null;
  }
  const isCustody = isPlainRecord(record) && record.kind === "llmwiki-state-custody" && record.version === 2 && record.project === project
    && isPlainRecord(record.entries) && entriesWellFormed(record.entries);
  return isCustody ? record as unknown as StateCustodyV2 : null;
}

/** Sources custody knew whose canonical entry has disappeared: their state, and what they owned, are unknown. */
export function lostSources(custody: StateCustodyV2, state: WikiState): string[] {
  return Object.keys(custody.entries).filter((source) => standingOf(custody, state, source) === "lost").sort();
}

/** Custody with `established` entries recorded as established by `proposalOperationId`. */
export function custodyWith(
  custody: StateCustodyV2, established: Readonly<Record<string, SourceState>>, proposalOperationId: string,
): StateCustodyV2 {
  const entries: Record<string, CustodyEntryV2> = { ...custody.entries };
  for (const [source, entry] of Object.entries(established)) {
    entries[source] = { entryDigest: recordDigest(entry), establishedBy: proposalOperationId };
  }
  return { ...custody, entries };
}

/** Where one source's canonical entry stands. */
function standingOf(custody: StateCustodyV2, state: WikiState, source: string): EntryStanding {
  if (state.sources[source] !== undefined) return "present";
  return custody.entries[source] === undefined ? "never-known" : "lost";
}
