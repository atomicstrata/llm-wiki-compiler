/**
 * @file test/portable/scale-topk.test.ts
 * @description Step 4: the keyword query keeps only the best `limit` hits while
 * it scans, and answers exactly as before. Each expectation is written from the
 * documented contract — score descending, then path; the same budget, fence,
 * postings and seek counts — not from the retention code.
 *
 * Covered: a best hit met LAST; equal scores across partitions; zero, exact
 * and exhausted budgets; a stale partition fenced before any posting, then
 * admitted after a rebuild; updates, removals and relabels; zero and oversized
 * limits; and the counters.
 */

import { describe, expect, it } from "bun:test";
import { KeywordPostingsIndex } from "../../src/portable/scale/keyword-index.js";
import { emptyCounters, type IndexChange, type IndexQuery } from "../../src/portable/scale/paged-store.js";

const OPEN = ["open"], SECRET = ["secret"];

/** A change for one page. */
function page(path: string, text: string | null, labels = OPEN): IndexChange {
  return { path, digest: text === null ? null : `sha256:${path}:${text}`, labels, text };
}

/** An index built from `pages` at epoch `e1`. */
function indexOf(pages: IndexChange[]): { index: KeywordPostingsIndex; counters: ReturnType<typeof emptyCounters> } {
  const counters = emptyCounters();
  const index = new KeywordPostingsIndex(counters, { root: "r0", labelEpoch: "e1" });
  index.update(pages, "r0", "r1", "e1");
  return { index, counters };
}

/** A query over both partitions at `e1`. */
function query(overrides: Partial<IndexQuery>): IndexQuery {
  return { labelSets: [OPEN, SECRET], labelEpoch: "e1", text: "tide", limit: 3, scanBudget: 1000, ...overrides };
}

/** The paths of an answer's hits, in order. */
const paths = (answer: { hits: readonly { path: string }[] }) => answer.hits.map((hit) => hit.path);

describe("bounded top-K ranking", () => {
  it("returns a best hit met last, after the limit was already filled", () => {
    const pages = Array.from({ length: 40 }, (_, at) => page(`p${String(at).padStart(2, "0")}`, at === 39 ? "tide tide tide" : "tide"));
    const { index } = indexOf(pages);
    expect(index.query(query({ limit: 1 }))).toEqual({ hits: [{ path: "p39", digest: "sha256:p39:tide tide tide", score: 3 }], truncated: false, postingsRead: 40, fenced: 0 });
  });

  it("orders equal scores by path across partitions, and higher scores first", () => {
    const { index } = indexOf([page("d", "tide"), page("b", "tide", SECRET), page("a", "tide tide", SECRET), page("c", "tide"), page("e", "tide tide")]);
    expect(paths(index.query(query({ limit: 4 })))).toEqual(["a", "e", "b", "c"]);
    expect(paths(index.query(query({ limit: 25 })))).toEqual(["a", "e", "b", "c", "d"]);
    expect(index.query(query({ limit: 0 })).hits).toEqual([]);
  });

  it("honours zero, exact and exhausted budgets with the same postings and truncation", () => {
    const { index } = indexOf(["a", "b", "c", "d", "e"].map((name) => page(name, name === "e" ? "tide tide" : "tide")));
    expect(index.query(query({ scanBudget: 0 }))).toEqual({ hits: [], truncated: true, postingsRead: 0, fenced: 0 });
    expect(index.query(query({ scanBudget: 5, limit: 2 }))).toMatchObject({ truncated: false, postingsRead: 5 });
    expect(paths(index.query(query({ scanBudget: 5, limit: 2 })))).toEqual(["e", "a"]);
    const exhausted = index.query(query({ scanBudget: 3, limit: 2 }));
    expect([paths(exhausted), exhausted.truncated, exhausted.postingsRead]).toEqual([["a", "b"], true, 3]);
  });
});

describe("fences, maintenance and counters are unchanged", () => {
  it("fences a stale partition before reading any posting, and admits it after a rebuild", async () => {
    const { index, counters } = indexOf([page("a", "tide"), page("s", "tide tide", SECRET)]);
    const stale = index.query(query({ labelEpoch: "e2" }));
    expect([stale.hits, stale.fenced, stale.postingsRead, counters.postingsRead]).toEqual([[], 2, 0, 0]);
    /** The catalog the rebuild traverses: the same two pages. */
    async function* entries() { yield page("a", "tide"); yield page("s", "tide tide", SECRET); }
    expect(await index.rebuild(entries(), "r2", "e2", () => true)).toBe(true);
    expect(paths(index.query(query({ labelEpoch: "e2" })))).toEqual(["s", "a"]);
  });

  it("reflects an update, a removal and a relabel", () => {
    const { index } = indexOf([page("a", "tide"), page("b", "tide"), page("c", "tide")]);
    index.update([page("c", "tide tide tide"), page("a", null), page("b", "tide", SECRET)], "r1", "r2", "e1");
    expect(paths(index.query(query({})))).toEqual(["c", "b"]);
    expect(paths(index.query(query({ labelSets: [OPEN] })))).toEqual(["c"]);
  });

  it("counts the shortest list's postings and one seek per opened partition per term", () => {
    // Open: tide and moon each list a and c (2 postings read). Secret: moon lists nothing, so it drives and reads none.
    const { index, counters } = indexOf([page("a", "tide moon"), page("b", "tide", SECRET), page("c", "moon tide")]);
    const answer = index.query(query({ text: "tide moon", limit: 1 }));
    expect([paths(answer), answer.postingsRead, counters.postingsRead, counters.indexTermSeeks]).toEqual([["a"], 2, 2, 4]);
  });
});
