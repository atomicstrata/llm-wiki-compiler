/**
 * Pure rules for content-bound embedding retry budgets: the exclusion and
 * release decision, the one-time legacy grant, cross-file and within-file
 * duplicate resolution, capacity fitting that never evicts an existing entry,
 * and settlement per run outcome. I/O and the real core are exercised in the
 * attempt-accounting and disabled-contract suites.
 */
import { describe, expect, it } from "vitest";
import { MAX_PENDING_EMBEDDING_ATTEMPTS as MAX } from "../src/utils/constants.js";
import type { EmbeddingRunOutcome } from "../src/utils/embedding-attempts.js";
import { normalizeMarker, type PendingEmbedding } from "../src/utils/pending-embeddings.js";
import { decideRetry, dropShadowedPending, fitAdmissions, settleRetry, type SettleInput } from "../src/utils/retry-exclusions.js";
import { fullEmbeddingMarker } from "./fixtures/embedding-marker-capacity.js";

const PAGE = "concepts/page";
const OLD = "aaaaaaaaaaaaaaaa";
const NEW = "bbbbbbbbbbbbbbbb";

/** A page's retry entry, optionally bound to content. */
function entry(attempts: number, contentHash?: string, pageId = PAGE): PendingEmbedding {
  return contentHash === undefined ? { pageId, attempts } : { pageId, attempts, contentHash };
}

describe("decideRetry", () => {
  it("excludes unchanged content that is quarantined or exhausted in pending", () => {
    expect(decideRetry(PAGE, OLD, entry(MAX, OLD), undefined)).toEqual({ kind: "excluded" });
    expect(decideRetry(PAGE, OLD, undefined, entry(MAX, OLD))).toEqual({ kind: "excluded" });
  });

  it("releases changed content with a fresh, pre-charged budget", () => {
    expect(decideRetry(PAGE, NEW, entry(MAX, OLD), undefined))
      .toEqual({ kind: "admit", entry: entry(1, NEW), releasesQuarantine: true, legacyGrant: false });
    expect(decideRetry(PAGE, NEW, undefined, entry(MAX, OLD)))
      .toEqual({ kind: "admit", entry: entry(1, NEW), releasesQuarantine: false, legacyGrant: false });
  });

  it("grants a blocked legacy exclusion once, binding it to the live content", () => {
    expect(decideRetry(PAGE, OLD, entry(MAX), undefined))
      .toEqual({ kind: "admit", entry: entry(1, OLD), releasesQuarantine: true, legacyGrant: true });
    expect(decideRetry(PAGE, OLD, undefined, entry(MAX)))
      .toEqual({ kind: "admit", entry: entry(1, OLD), releasesQuarantine: false, legacyGrant: true });
  });

  it("charges unchanged, unblocked content and lets an unblocked legacy entry adopt the live hash", () => {
    expect(decideRetry(PAGE, OLD, undefined, entry(2, OLD))).toMatchObject({ entry: entry(3, OLD) });
    expect(decideRetry(PAGE, OLD, undefined, entry(2))).toMatchObject({ entry: entry(3, OLD), legacyGrant: false });
    expect(decideRetry(PAGE, NEW, undefined, entry(2, OLD))).toMatchObject({ entry: entry(1, NEW) });
  });

  it("starts ineligibility-aged entries afresh once the page has content", () => {
    const aged: PendingEmbedding = { pageId: PAGE, attempts: MAX, ineligible: true };
    expect(decideRetry(PAGE, OLD, aged, undefined)).toMatchObject({ kind: "admit", entry: entry(1, OLD), legacyGrant: false });
  });

  it("treats a hashed pending entry beside a stale quarantine entry as a completed release", () => {
    // Pending bound to other content means the release already happened: no second grant.
    expect(decideRetry(PAGE, NEW, entry(MAX), entry(2, NEW)))
      .toEqual({ kind: "admit", entry: entry(3, NEW), releasesQuarantine: true, legacyGrant: false });
    expect(decideRetry(PAGE, NEW, entry(MAX, OLD), entry(MAX, NEW))).toEqual({ kind: "excluded" });
  });

  it("lets quarantine win over pending entries for the same content or without a hash", () => {
    expect(decideRetry(PAGE, OLD, entry(MAX, OLD), entry(1, OLD))).toEqual({ kind: "excluded" });
    expect(decideRetry(PAGE, OLD, entry(MAX, OLD), entry(1))).toEqual({ kind: "excluded" });
  });
});

describe("duplicate resolution", () => {
  it("keeps the most attempts within a file, preferring a hashed entry on a tie", () => {
    expect(normalizeMarker([entry(1, OLD), entry(3)])).toEqual([entry(3)]);
    expect(normalizeMarker([entry(2), entry(2, OLD)])).toEqual([entry(2, OLD)]);
    expect(normalizeMarker([entry(2, OLD), entry(2)])).toEqual([entry(2, OLD)]);
  });

  it("drops only pending entries a quarantine entry already covers", () => {
    const pending = [entry(1), entry(1, OLD, "concepts/same"), entry(1, NEW, "concepts/released"), entry(1, OLD, "concepts/other")];
    const quarantine = [entry(MAX, OLD), entry(MAX, OLD, "concepts/same"), entry(MAX, OLD, "concepts/released")];
    expect(dropShadowedPending(pending, quarantine, () => true))
      .toEqual([entry(1, NEW, "concepts/released"), entry(1, OLD, "concepts/other")]);
    expect(dropShadowedPending(pending, quarantine, () => false)).toEqual(pending);
  });
});

describe("fitAdmissions", () => {
  it("never evicts an existing entry, deferring new admissions before in-place charges", () => {
    const full = fullEmbeddingMarker("count", 1);
    const charge = { ...full[0], attempts: 2, contentHash: OLD };
    const fresh = entry(1, OLD, "concepts/fresh");
    const fit = fitAdmissions(full, [fresh, charge]);
    expect(fit.admitted).toEqual([charge]);
    expect(fit.deferred).toEqual(["concepts/fresh"]);
    expect(normalizeMarker(fit.entries).map(e => e.pageId)).toEqual(full.map(e => e.pageId));
  });

  it("defers a charge whose hash would push an existing entry past the byte cap", () => {
    const full = fullEmbeddingMarker("bytes", 1);
    const fit = fitAdmissions(full, [{ ...full[0], attempts: 2, contentHash: OLD }]);
    expect(fit.admitted).toEqual([]);
    expect(fit.entries).toEqual(full);
  });
});

/** Settle one run over pages a (admitted), b (admitted) and c (not admitted). */
function settle(outcome: EmbeddingRunOutcome, overrides: Partial<SettleInput> = {}) {
  return settleRetry({
    pending: [entry(2, OLD, "concepts/a"), entry(1, OLD, "concepts/b"), entry(3, undefined, "concepts/c")],
    admitted: new Set(["concepts/a", "concepts/b"]),
    outcome,
    sentPages: new Set(["concepts/a"]),
    eligible: new Set(["concepts/a", "concepts/b", "concepts/c"]),
    embedded: new Set(),
    pruned: new Set(),
    inScope: () => true,
    ...overrides,
  });
}

describe("settleRetry", () => {
  it("clears persisted pages and leaves pages that were not admitted untouched", () => {
    expect(settle({ kind: "persisted" }).pending).toEqual([entry(3, undefined, "concepts/c")]);
  });

  it("charges only the failing request's pages and refunds the rest", () => {
    const { pending } = settle({ kind: "request-failed", failed: new Set(["concepts/b"]) });
    expect(pending).toEqual([entry(1, OLD, "concepts/a"), entry(1, OLD, "concepts/b"), entry(3, undefined, "concepts/c")]);
  });

  it("keeps the charge on every sent page when the run failed after its requests succeeded", () => {
    const { pending } = settle({ kind: "after-requests" });
    expect(pending).toEqual([entry(2, OLD, "concepts/a"), entry(0, OLD, "concepts/b"), entry(3, undefined, "concepts/c")]);
  });

  it("refunds every admitted page when nothing was sent", () => {
    const { pending } = settle({ kind: "before-requests" });
    expect(pending.map(e => e.attempts)).toEqual([1, 0, 3]);
  });

  it("quarantines a charged page at the cap with its content hash", () => {
    const { pending, quarantine } = settle({ kind: "request-failed", failed: new Set(["concepts/a"]) }, {
      pending: [entry(MAX, OLD, "concepts/a")], admitted: new Set(["concepts/a"]),
    });
    expect(quarantine).toEqual([entry(MAX, OLD, "concepts/a")]);
    expect(pending).toEqual([]);
  });

  it("ages ineligible pages separately, clears pruned ones, and ignores out-of-scope entries", () => {
    const pending = [entry(MAX - 1, OLD, "concepts/gone"), entry(1, undefined, "concepts/deleted"), entry(2, OLD, "concepts/other")];
    const result = settle({ kind: "persisted" }, {
      pending, admitted: new Set(), eligible: new Set(), pruned: new Set(["concepts/deleted"]),
      inScope: id => id !== "concepts/other",
    });
    expect(result.quarantine).toEqual([{ pageId: "concepts/gone", attempts: MAX, ineligible: true }]);
    expect(result.pending).toEqual([entry(2, OLD, "concepts/other")]);
  });

  it("does not age anything when the core threw before reporting eligibility", () => {
    const { pending } = settle({ kind: "before-requests" }, { admitted: new Set(), eligible: null });
    expect(pending.map(e => e.attempts)).toEqual([2, 1, 3]);
  });
});
