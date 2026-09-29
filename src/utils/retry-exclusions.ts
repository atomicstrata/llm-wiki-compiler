/**
 * @file src/utils/retry-exclusions.ts
 * @description Pure rules for content-bound embedding retry budgets.
 *
 * A retry entry's `contentHash` records the content its attempts were charged
 * against. A page is excluded from refresh (quarantined, or exhausted in the
 * pending file when quarantine is full) only while its live content still
 * hashes to that value. Changed content, however it changed (compile, review,
 * import, an external edit, even while refreshes were disabled), is admitted
 * with a fresh budget; unchanged content keeps its limit. Entries written before
 * hashing existed (legacy) get one bounded grant, which binds them to a hash.
 *
 * Nothing here performs I/O: {@link EmbeddingRetry} applies these decisions and
 * verifies every write, because the marker writer swallows write failures.
 */

import { MAX_PENDING_EMBEDDING_ATTEMPTS } from "./constants.js";
import type { EmbeddingRunOutcome } from "./embedding-attempts.js";
import type { PageId } from "./page-id.js";
import { normalizeMarker, type PendingEmbedding } from "./pending-embeddings.js";

/** True once an entry has used its whole retry budget. */
function exhausted(entry: PendingEmbedding): boolean {
  return entry.attempts >= MAX_PENDING_EMBEDDING_ATTEMPTS;
}

/** An exclusion from before content hashing: neither bound to content nor aged as ineligible. */
function isLegacy(entry: PendingEmbedding): boolean {
  return entry.contentHash === undefined && entry.ineligible !== true;
}

/** What one prepared page's retry entries mean for this run. */
export type RetryDecision =
  | { kind: "excluded" }
  | { kind: "admit"; entry: PendingEmbedding; releasesQuarantine: boolean; legacyGrant: boolean };

/**
 * Resolve which entry excludes a page when it may appear in both files. A crash
 * or swallowed write between a release's two steps leaves a hashed pending entry
 * beside a quarantine entry for other content: the release already happened, so
 * the pending entry is authoritative and the quarantine entry is stale.
 */
function blockingEntry(
  quarantined: PendingEmbedding | undefined,
  pending: PendingEmbedding | undefined,
): { blocker?: PendingEmbedding; staleQuarantine: boolean } {
  if (quarantined && pending?.contentHash && pending.contentHash !== quarantined.contentHash) {
    return { blocker: exhausted(pending) ? pending : undefined, staleQuarantine: true };
  }
  if (quarantined) return { blocker: quarantined, staleQuarantine: false };
  return { blocker: pending && exhausted(pending) ? pending : undefined, staleQuarantine: false };
}

/**
 * Decide a prepared page and pre-charge its attempt: the entry is written ahead
 * of any provider request, so no content can be sent without a durable charge.
 */
export function decideRetry(
  pageId: PageId,
  liveHash: string,
  quarantined: PendingEmbedding | undefined,
  pending: PendingEmbedding | undefined,
): RetryDecision {
  const { blocker, staleQuarantine } = blockingEntry(quarantined, pending);
  if (blocker) {
    if (blocker.contentHash === liveHash) return { kind: "excluded" };
    const entry = { pageId, attempts: 1, contentHash: liveHash };
    return { kind: "admit", entry, releasesQuarantine: quarantined !== undefined, legacyGrant: isLegacy(blocker) };
  }
  // An unblocked legacy entry adopts the live content and keeps its count; only a
  // blocked legacy entry is granted a fresh budget, once (above).
  const sameContent = pending !== undefined && (pending.contentHash === liveHash || isLegacy(pending));
  const entry = { pageId, attempts: sameContent ? pending.attempts + 1 : 1, contentHash: liveHash };
  return { kind: "admit", entry, releasesQuarantine: staleQuarantine, legacyGrant: false };
}

/**
 * Drop pending entries that a quarantine entry for the same content already
 * covers (quarantine wins): an interrupted settlement can leave both, and the
 * redundant pending entry would otherwise linger. A pending entry bound to other
 * content is kept, since it records a completed release.
 */
export function dropShadowedPending(
  pending: PendingEmbedding[],
  quarantined: PendingEmbedding[],
  inScope: (pageId: PageId) => boolean,
): PendingEmbedding[] {
  const hashes = new Map(quarantined.map(entry => [entry.pageId, entry.contentHash]));
  return pending.filter(entry => !inScope(entry.pageId) || !hashes.has(entry.pageId) ||
    (entry.contentHash !== undefined && entry.contentHash !== hashes.get(entry.pageId)));
}

/**
 * Apply pre-charged admissions to the pending list without letting the marker's
 * caps drop an entry that was already there. Admissions that do not fit are
 * deferred, newest first: a page is never attempted without a durable charge,
 * and no unrelated budget or exclusion is lost to make room for it.
 */
export function fitAdmissions(
  pending: PendingEmbedding[],
  admissions: PendingEmbedding[],
): { entries: PendingEmbedding[]; admitted: PendingEmbedding[]; deferred: PageId[] } {
  const existing = new Set(pending.map(entry => entry.pageId));
  // Updates to existing entries are deferred last: they cost no new slot.
  const ordered = [...admissions].sort((a, b) => Number(existing.has(b.pageId)) - Number(existing.has(a.pageId)));
  const fits = (count: number): boolean => {
    const admitted = ordered.slice(0, count);
    const kept = new Set(normalizeMarker(applyAdmissions(pending, admitted)).map(entry => entry.pageId));
    return [...existing, ...admitted.map(entry => entry.pageId)].every(id => kept.has(id));
  };
  // Fitting is monotone in the number of admissions, so binary-search the largest prefix.
  let low = 0;
  let high = ordered.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  const admitted = ordered.slice(0, low);
  return { entries: applyAdmissions(pending, admitted), admitted, deferred: ordered.slice(low).map(entry => entry.pageId) };
}

/** Replace admitted pages' entries in place and append new ones. */
function applyAdmissions(pending: PendingEmbedding[], admitted: PendingEmbedding[]): PendingEmbedding[] {
  const byId = new Map(admitted.map(entry => [entry.pageId, entry]));
  const updated = pending.map(entry => byId.get(entry.pageId) ?? entry);
  const present = new Set(pending.map(entry => entry.pageId));
  return [...updated, ...admitted.filter(entry => !present.has(entry.pageId))];
}

/** Everything settlement needs to know about one finished run. */
export interface SettleInput {
  pending: PendingEmbedding[];
  admitted: ReadonlySet<PageId>;
  outcome: EmbeddingRunOutcome;
  sentPages: ReadonlySet<PageId>;
  /** Live-eligible pages the core considered; null when the core threw before reporting. */
  eligible: ReadonlySet<PageId> | null;
  /** Pages the core reported embedded by returning normally: their vectors are persisted. */
  embedded: ReadonlySet<PageId>;
  pruned: ReadonlySet<PageId>;
  inScope: (pageId: PageId) => boolean;
}

/**
 * Settle a run: clear persisted pages, keep the pre-charge on pages whose paid
 * work failed or was lost after all requests succeeded, refund everything else
 * that was admitted, and age in-scope pages that are no longer eligible.
 */
export function settleRetry(input: SettleInput): { pending: PendingEmbedding[]; quarantine: PendingEmbedding[] } {
  const pending: PendingEmbedding[] = [];
  const quarantine: PendingEmbedding[] = [];
  const route = (entry: PendingEmbedding): void => { (exhausted(entry) ? quarantine : pending).push(entry); };
  for (const entry of input.pending) {
    const next = settleEntry(entry, input);
    if (next === "clear") continue;
    if (next === entry) pending.push(entry);
    else route(next);
  }
  return { pending, quarantine };
}

/** One entry's settled state; returning the same object means untouched. */
function settleEntry(entry: PendingEmbedding, input: SettleInput): PendingEmbedding | "clear" {
  const id = entry.pageId;
  if (!input.inScope(id)) return entry;
  if (input.embedded.has(id) || input.pruned.has(id)) return "clear";
  if (input.admitted.has(id)) return settleAdmitted(entry, input);
  return ageIfIneligible(entry, input.eligible);
}

/** A pre-charged page: cleared once persisted, otherwise charged or refunded. */
function settleAdmitted(entry: PendingEmbedding, input: SettleInput): PendingEmbedding | "clear" {
  if (input.outcome.kind === "persisted") return "clear";
  return charged(entry.pageId, input) ? { ...entry } : { ...entry, attempts: Math.max(0, entry.attempts - 1) };
}

/** Age a page the core could not collect, separately from provider-failure charges. */
function ageIfIneligible(entry: PendingEmbedding, eligible: ReadonlySet<PageId> | null): PendingEmbedding {
  if (eligible === null || eligible.has(entry.pageId) || exhausted(entry)) return entry;
  return { pageId: entry.pageId, attempts: entry.attempts + 1, ineligible: true };
}

/** Whether a pre-charged page keeps its charge for this outcome. */
function charged(pageId: PageId, input: SettleInput): boolean {
  if (input.outcome.kind === "request-failed") return input.outcome.failed.has(pageId);
  return input.outcome.kind === "after-requests" && input.sentPages.has(pageId);
}
