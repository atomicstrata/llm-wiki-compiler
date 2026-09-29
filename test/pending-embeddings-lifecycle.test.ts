/**
 * @file test/pending-embeddings-lifecycle.test.ts
 * @description Per-id lifecycle coverage for the pending-embedding marker's merge
 * helper in `src/utils/pending-embeddings.ts`. Settlement and quarantine rules
 * live in `src/utils/retry-exclusions.ts` and are covered by
 * `test/retry-exclusions.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { mergeFreshAttempts, type PendingEmbedding } from "../src/utils/pending-embeddings.js";

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
