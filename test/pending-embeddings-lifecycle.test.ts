/**
 * @file test/pending-embeddings-lifecycle.test.ts
 * @description Per-id lifecycle coverage for the pending-embedding marker — the
 * merge/settle/quarantine helpers in `src/utils/pending-embeddings.ts`.
 *
 * These are the HIGH/MED audit findings expressed as pure-function tests:
 *  - POISON-ID WEDGE (HIGH): an id that fails for a non-transient reason is
 *    QUARANTINED after MAX_PENDING_EMBEDDING_ATTEMPTS failures instead of being
 *    re-attempted forever (re-billing the provider) and wedging the all-or-nothing
 *    batch it shares with a healthy id.
 *  - CLEAR-ONLY-EMBEDDED (MED): on success, only the ids the core ACTUALLY embedded
 *    are cleared; an id the core SKIPPED (ineligible, not in the eligible set) is
 *    retained with an incremented attempt count, never cleared un-embedded, and
 *    eventually quarantined if it never becomes embeddable.
 */

import { describe, it, expect } from "vitest";
import {
  mergeFreshAttempts,
  settleAfterSuccess,
  settleAfterFailure,
  type PendingEmbedding,
  type SettleResult,
} from "../src/utils/pending-embeddings.js";
import { MAX_PENDING_EMBEDDING_ATTEMPTS } from "../src/utils/constants.js";

describe("mergeFreshAttempts", () => {
  it("adds new ids at attempts:0 and PRESERVES existing attempt counts", () => {
    const prior: PendingEmbedding[] = [{ pageId: "concepts/poison", attempts: 3 }];
    const merged = mergeFreshAttempts(prior, ["concepts/poison", "concepts/new"]);
    expect(merged).toEqual([
      { pageId: "concepts/poison", attempts: 3 }, // re-changed poison keeps its age-out progress
      { pageId: "concepts/new", attempts: 0 },
    ]);
  });
});

describe("mergeFreshAttempts — priority ordering (fresh first, backlog after)", () => {
  it("puts fresh ids FIRST and the prior-only backlog AFTER them", () => {
    const prior: PendingEmbedding[] = [
      { pageId: "concepts/old-a", attempts: 1 },
      { pageId: "concepts/old-b", attempts: 2 },
    ];
    const merged = mergeFreshAttempts(prior, ["concepts/fresh-1", "concepts/fresh-2"]);
    expect(merged.map((e) => e.pageId)).toEqual([
      "concepts/fresh-1", // priority partition (this run's changes) leads
      "concepts/fresh-2",
      "concepts/old-a", // backlog fills the remaining space
      "concepts/old-b",
    ]);
  });

  it("keeps a re-changed id in the FRESH partition while carrying its prior attempts", () => {
    const prior: PendingEmbedding[] = [
      { pageId: "concepts/backlog", attempts: 1 },
      { pageId: "concepts/poison", attempts: 3 },
    ];
    const merged = mergeFreshAttempts(prior, ["concepts/poison"]);
    expect(merged).toEqual([
      { pageId: "concepts/poison", attempts: 3 }, // re-changed → fresh partition, attempts carried
      { pageId: "concepts/backlog", attempts: 1 }, // prior-only → backlog
    ]);
  });

  it("dedups the fresh ids among themselves, preserving first-seen order", () => {
    const merged = mergeFreshAttempts([], ["concepts/a", "concepts/b", "concepts/a"]);
    expect(merged).toEqual([
      { pageId: "concepts/a", attempts: 0 },
      { pageId: "concepts/b", attempts: 0 },
    ]);
  });
});

describe("settleAfterSuccess — clear only actually-embedded ids (MED)", () => {
  it("clears embedded A, retains ineligible B with attempts incremented", () => {
    const merged = mergeFreshAttempts([], ["concepts/a", "concepts/b"]);
    // Core embedded A; B was not in the eligible universe (ineligible now).
    const settled = settleAfterSuccess(merged, ["concepts/a"], ["concepts/a"]);
    expect(settled.survivors).toEqual([{ pageId: "concepts/b", attempts: 1 }]);
    expect(settled.quarantined).toEqual([]); // B retained, NOT silently dropped
  });

  it("keeps an eligible-but-unembedded id unchanged (unusual)", () => {
    const merged: PendingEmbedding[] = [{ pageId: "concepts/a", attempts: 2 }];
    const settled = settleAfterSuccess(merged, [], ["concepts/a"]); // eligible, not embedded
    expect(settled.survivors).toEqual([{ pageId: "concepts/a", attempts: 2 }]);
  });

  it("quarantines a no-longer-live id once it crosses the attempt cap", () => {
    const atCap: PendingEmbedding[] = [
      { pageId: "concepts/gone", attempts: MAX_PENDING_EMBEDDING_ATTEMPTS - 1 },
    ];
    const settled = settleAfterSuccess(atCap, [], []); // not embedded, not eligible
    expect(settled.survivors).toEqual([]);
    expect(settled.quarantined).toEqual([
      { pageId: "concepts/gone", attempts: MAX_PENDING_EMBEDDING_ATTEMPTS },
    ]);
  });
});

describe("settleAfterFailure — whole batch failed", () => {
  it("increments attempts for every id in the failed batch", () => {
    const merged = mergeFreshAttempts([], ["concepts/a", "concepts/b"]);
    const settled = settleAfterFailure(merged, ["concepts/a", "concepts/b"]);
    expect(settled.survivors).toEqual([
      { pageId: "concepts/a", attempts: 1 },
      { pageId: "concepts/b", attempts: 1 },
    ]);
  });

  it("leaves an entry outside the batch untouched", () => {
    const merged: PendingEmbedding[] = [
      { pageId: "concepts/a", attempts: 0 },
      { pageId: "concepts/other", attempts: 2 },
    ];
    const settled = settleAfterFailure(merged, ["concepts/a"]);
    expect(settled.survivors).toEqual([
      { pageId: "concepts/a", attempts: 1 },
      { pageId: "concepts/other", attempts: 2 }, // not in the batch → untouched
    ]);
  });
});

describe("poison-id wedge (the HIGH) — simulated across compiles", () => {
  /**
   * Simulate one compile: the batch contains `concepts/poison`, which makes the
   * all-or-nothing core THROW; everything else would resolve. We drive only the
   * settle helpers (the marker state machine), which is exactly what
   * `safelyUpdateEmbeddings` does on the catch path.
   */
  function failingCompile(marker: PendingEmbedding[]): SettleResult {
    const toRefresh = marker.map((e) => e.pageId); // batch fails because poison is present
    return settleAfterFailure(marker, toRefresh);
  }

  it("quarantines poison after the cap, then the co-pending healthy id embeds (no longer wedged)", () => {
    // Poison has already been failing across earlier compiles (it joined the marker
    // before healthy did); healthy joins fresh on this compile. This is the real
    // shape of the wedge: a long-failing id keeps re-throwing the all-or-nothing
    // batch, starving every id that arrives after it.
    let marker = mergeFreshAttempts(
      [{ pageId: "concepts/poison", attempts: MAX_PENDING_EMBEDDING_ATTEMPTS - 1 }],
      ["concepts/healthy"],
    );
    const quarantined: PendingEmbedding[] = [];

    // The batch FAILS while poison is present. Without the attempt cap this loops
    // forever (poison re-throws every compile, re-billing the provider); the cap
    // gives the wedge TEETH. Bound generously so a never-quarantine regression fails.
    let compiles = 0;
    while (marker.some((e) => e.pageId === "concepts/poison")) {
      expect(compiles++).toBeLessThan(5); // teeth: never infinite
      const settled = failingCompile(marker);
      marker = settled.survivors;
      quarantined.push(...settled.quarantined);
    }

    // Poison aged out on the first failing compile (it was already at cap-1);
    // healthy survived (only one failed attempt), still under the cap.
    expect(compiles).toBe(1);
    expect(quarantined.map((e) => e.pageId)).toEqual(["concepts/poison"]);
    expect(quarantined[0].attempts).toBe(MAX_PENDING_EMBEDDING_ATTEMPTS);
    expect(marker).toEqual([{ pageId: "concepts/healthy", attempts: 1 }]);

    // Next compile: poison gone, so the batch SUCCEEDS and healthy clears.
    const ok = settleAfterSuccess(marker, ["concepts/healthy"], ["concepts/healthy"]);
    expect(ok.survivors).toEqual([]); // healthy embedded + cleared — wedge is closed
  });
});
