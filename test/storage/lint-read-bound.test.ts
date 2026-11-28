/**
 * @file test/storage/lint-read-bound.test.ts
 * @description Stage A1: the page collection reads at most
 * `LINT_PAGE_READ_CONCURRENCY` page bodies at once, in BOTH scopes, however
 * deep the wiki-wide walk goes, and returns exactly what it returned before:
 * the same pages, in the same order, with the same raw errors and policy.
 *
 * Measured, not mirrored: the double counts reads actually in flight, each
 * finishing on a later event-loop turn, and the expected results are written
 * from the collection's documented order (generic: concepts then queries, each
 * in listing order; wiki-wide: sorted by path), never from the scheduler.
 */

import { describe, expect, it } from "bun:test";
import { collectAllPagesFrom, LINT_PAGE_READ_CONCURRENCY } from "../../src/linter/rules-shared.js";
import { addEntry, emptyFacts, genericFacts, measuringSources, nestedFacts, type ReadFacts } from "./lint-read-bound-doubles.js";

/** The pages `facts` holds under `dir`, in its listing order, as the collection reports them. */
function listed(facts: ReadFacts, dir: string): { filePath: string; content: string }[] {
  return (facts.directories.get(dir) ?? []).map((entry) => ({ filePath: `/project/${dir}/${entry.name}`, content: facts.files.get(`${dir}/${entry.name}`)! }));
}

/** Every file page `facts` holds, sorted by reported path. */
function allSorted(facts: ReadFacts): { filePath: string; content: string }[] {
  return [...facts.files].map(([relPath, content]) => ({ filePath: `/project/${relPath}`, content }))
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
}

describe("the body-read bound", () => {
  it("keeps generic reads within the bound and returns concepts then queries in listing order", async () => {
    const facts = genericFacts(257);
    const { sources, work } = measuringSources(facts);
    const pages = await collectAllPagesFrom(sources, "generic");
    expect(pages).toEqual([...listed(facts, "wiki/concepts"), ...listed(facts, "wiki/queries")]);
    expect(work).toEqual({ active: 0, peak: LINT_PAGE_READ_CONCURRENCY, reads: 257 });
  });

  it("keeps a nested wiki-wide walk within ONE bound and returns every page sorted by path", async () => {
    const facts = nestedFacts(257);
    const { sources, work } = measuringSources(facts);
    const pages = await collectAllPagesFrom(sources, "wiki-wide");
    expect(pages).toEqual(allSorted(facts));
    expect(work).toEqual({ active: 0, peak: LINT_PAGE_READ_CONCURRENCY, reads: 257 });
  });

  it("gives each invocation its own bound and reads afresh, so an edit between calls is seen", async () => {
    const facts = genericFacts(40);
    const { sources, work } = measuringSources(facts);
    const [first, second] = await Promise.all([collectAllPagesFrom(sources, "generic"), collectAllPagesFrom(sources, "generic")]);
    expect(second).toEqual(first);
    expect(work.peak).toBeLessThanOrEqual(2 * LINT_PAGE_READ_CONCURRENCY);
    facts.files.set("wiki/concepts/page-0000.md", "# Edited between calls\n");
    const after = await collectAllPagesFrom(sources, "generic");
    expect(after.find((page) => page.filePath.endsWith("page-0000.md"))?.content).toBe("# Edited between calls\n");
    expect(work.reads).toBe(120);
  });
});

describe("unchanged failure and traversal policy", () => {
  it("rejects with the raw error of a failing read, in both scopes", async () => {
    const generic = genericFacts(30), nested = nestedFacts(30);
    const failure = new Error("EIO on one page");
    generic.failing.set("wiki/queries/page-0011.md", failure);
    nested.failing.set([...nested.files.keys()][7]!, failure);
    await expect(collectAllPagesFrom(measuringSources(generic).sources, "generic")).rejects.toBe(failure);
    await expect(collectAllPagesFrom(measuringSources(nested).sources, "wiki-wide")).rejects.toBe(failure);
  });

  it("returns nothing for missing or empty directories, and only what exists", async () => {
    expect(await collectAllPagesFrom(measuringSources(emptyFacts()).sources, "generic")).toEqual([]);
    expect(await collectAllPagesFrom(measuringSources(emptyFacts()).sources, "wiki-wide")).toEqual([]);
    const onlyQueries = emptyFacts();
    addEntry(onlyQueries, "wiki/queries", { name: "q.md", kind: "file" }, "# Q\n");
    onlyQueries.directories.set("wiki/concepts", []);
    expect(await collectAllPagesFrom(measuringSources(onlyQueries).sources, "generic")).toEqual([{ filePath: "/project/wiki/queries/q.md", content: "# Q\n" }]);
  });

  it("keeps the walk's depth, skips links, other entries, dot entries and non-markdown, and treats an unlistable directory as empty", async () => {
    const facts = emptyFacts();
    let dir = "wiki";
    for (let depth = 1; depth <= 6; depth += 1) {
      addEntry(facts, dir, { name: `at-${depth}.md`, kind: "file" }, `# Depth ${depth}\n`);
      addEntry(facts, dir, { name: `l${depth}`, kind: "directory" });
      dir = `${dir}/l${depth}`;
    }
    // One level past the admitted depth: this page is never reached while the cut-off holds.
    addEntry(facts, dir, { name: "beyond-depth.md", kind: "file" }, "# Beyond the depth limit\n");
    addEntry(facts, "wiki", { name: "link.md", kind: "link" });
    addEntry(facts, "wiki", { name: "pipe.md", kind: "other" });
    addEntry(facts, "wiki", { name: ".obsidian", kind: "directory" });
    addEntry(facts, "wiki/.obsidian", { name: "hidden.md", kind: "file" }, "# Hidden\n");
    addEntry(facts, "wiki", { name: "notes.txt", kind: "file" }, "not markdown");
    addEntry(facts, "wiki", { name: "locked", kind: "directory" });
    facts.unlistable.add("wiki/locked");
    const pages = await collectAllPagesFrom(measuringSources(facts).sources, "wiki-wide");
    expect(pages.map((page) => page.content)).toEqual(["# Depth 1\n", "# Depth 2\n", "# Depth 3\n", "# Depth 4\n", "# Depth 5\n", "# Depth 6\n"]);
  });
});
