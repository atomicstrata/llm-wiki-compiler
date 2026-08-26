import { describe, it, expect } from "vitest";
import {
  findAffectedSources,
  findReconciliationSlugs,
  findLateAffectedSources,
  findSharedConcepts,
  type ExtractionResult,
} from "../src/compiler/deps.js";
import type { WikiState, SourceChange } from "../src/utils/types.js";

function makeState(
  sources: Record<string, { hash: string; concepts: string[] }>,
  frozenSlugs?: string[],
): WikiState {
  const mapped: WikiState["sources"] = {};
  for (const [file, data] of Object.entries(sources)) {
    mapped[file] = { ...data, compiledAt: "2026-01-01T00:00:00.000Z" };
  }
  return { version: 1, indexHash: "", sources: mapped, frozenSlugs };
}

describe("findAffectedSources", () => {
  it("returns empty for single-owner concepts", () => {
    const state = makeState({
      "a.md": { hash: "h1", concepts: ["concept-x"] },
      "b.md": { hash: "h2", concepts: ["concept-y"] },
    });
    const changes: SourceChange[] = [{ file: "a.md", status: "changed" }];
    expect(findAffectedSources(state, changes)).toEqual([]);
  });

  it("returns co-owners of shared concepts when one changes", () => {
    const state = makeState({
      "a.md": { hash: "h1", concepts: ["shared-concept"] },
      "b.md": { hash: "h2", concepts: ["shared-concept"] },
    });
    const changes: SourceChange[] = [{ file: "a.md", status: "changed" }];
    const affected = findAffectedSources(state, changes);
    expect(affected).toEqual(["b.md"]);
  });

  it("excludes deleted files from affected set", () => {
    const state = makeState({
      "a.md": { hash: "h1", concepts: ["shared"] },
      "b.md": { hash: "h2", concepts: ["shared"] },
      "c.md": { hash: "h3", concepts: ["shared"] },
    });
    const changes: SourceChange[] = [
      { file: "a.md", status: "changed" },
      { file: "b.md", status: "deleted" },
    ];
    const affected = findAffectedSources(state, changes);
    expect(affected).toEqual(["c.md"]);
    expect(affected).not.toContain("b.md");
  });

  it("recompiles surviving co-owners when a shared source is deleted", () => {
    const state = makeState({
      "deleted.md": { hash: "h1", concepts: ["shared"] },
      "survivor.md": { hash: "h2", concepts: ["shared"] },
      "unrelated.md": { hash: "h3", concepts: ["other"] },
    });
    const changes: SourceChange[] = [{ file: "deleted.md", status: "deleted" }];

    expect(findAffectedSources(state, changes)).toEqual(["survivor.md"]);
  });

  it("walks the full surviving co-owner graph after deletion", () => {
    const state = makeState({
      "a.md": { hash: "h1", concepts: ["x"] },
      "b.md": { hash: "h2", concepts: ["x", "y"] },
      "c.md": { hash: "h3", concepts: ["y"] },
    });
    const changes: SourceChange[] = [{ file: "a.md", status: "deleted" }];

    expect(findAffectedSources(state, changes)).toEqual(["b.md", "c.md"]);
  });

  it("excludes every deleted owner from a multi-owner rebuild", () => {
    const state = makeState({
      "a.md": { hash: "h1", concepts: ["shared"] },
      "b.md": { hash: "h2", concepts: ["shared"] },
      "c.md": { hash: "h3", concepts: ["shared"] },
    });
    const changes: SourceChange[] = [
      { file: "a.md", status: "deleted" },
      { file: "b.md", status: "deleted" },
    ];

    expect(findAffectedSources(state, changes)).toEqual(["c.md"]);
  });

  it("retries owners of persisted frozen concepts", () => {
    const state = makeState(
      {
        "a.md": { hash: "h1", concepts: ["shared"] },
        "b.md": { hash: "h2", concepts: ["shared"] },
      },
      ["shared"],
    );

    expect(findAffectedSources(state, [])).toEqual(["a.md", "b.md"]);
  });

  it("does not include already-changed files", () => {
    const state = makeState({
      "a.md": { hash: "h1", concepts: ["shared"] },
      "b.md": { hash: "h2", concepts: ["shared"] },
    });
    const changes: SourceChange[] = [
      { file: "a.md", status: "changed" },
      { file: "b.md", status: "changed" },
    ];
    expect(findAffectedSources(state, changes)).toEqual([]);
  });
});

describe("findReconciliationSlugs", () => {
  it("reconciles shared concepts when a source is deleted", () => {
    const state = makeState({
      "a.md": { hash: "h1", concepts: ["shared-concept"] },
      "b.md": { hash: "h2", concepts: ["shared-concept"] },
    });
    const changes: SourceChange[] = [{ file: "a.md", status: "deleted" }];
    const reconciliation = findReconciliationSlugs(state, changes);
    expect(reconciliation.has("shared-concept")).toBe(true);
  });

  it("does not rebuild exclusively-owned deleted concepts", () => {
    const state = makeState({
      "a.md": { hash: "h1", concepts: ["only-a"] },
      "b.md": { hash: "h2", concepts: ["only-b"] },
    });
    const changes: SourceChange[] = [{ file: "a.md", status: "deleted" }];
    const reconciliation = findReconciliationSlugs(state, changes);
    expect(reconciliation.has("only-a")).toBe(false);
  });

  it("loads persisted frozen slugs as reconciliation work", () => {
    const state = makeState(
      { "a.md": { hash: "h1", concepts: [] } },
      ["previously-frozen"],
    );
    const changes: SourceChange[] = [];
    const reconciliation = findReconciliationSlugs(state, changes);
    expect(reconciliation.has("previously-frozen")).toBe(true);
  });

  it("handles 3+ source concept with one deleted", () => {
    const state = makeState({
      "a.md": { hash: "h1", concepts: ["triple"] },
      "b.md": { hash: "h2", concepts: ["triple"] },
      "c.md": { hash: "h3", concepts: ["triple"] },
    });
    const changes: SourceChange[] = [{ file: "a.md", status: "deleted" }];
    const reconciliation = findReconciliationSlugs(state, changes);
    expect(reconciliation.has("triple")).toBe(true);
  });
});

describe("findLateAffectedSources", () => {
  it("detects unchanged sources sharing concepts with new sources", () => {
    const state = makeState({
      "existing.md": { hash: "h1", concepts: ["shared-concept"] },
    });
    const extractions: ExtractionResult[] = [
      {
        sourceFile: "new.md",
        sourcePath: "/tmp/new.md",
        sourceContent: "content",
        concepts: [{ concept: "Shared Concept", summary: "s", is_new: false }],
      },
    ];
    // Pass full changes including the unchanged entry — must not suppress it.
    const changes: SourceChange[] = [
      { file: "new.md", status: "new" },
      { file: "existing.md", status: "unchanged" },
    ];
    const affected = findLateAffectedSources(extractions, state, changes);
    expect(affected).toEqual(["existing.md"]);
  });

  it("skips sources already in the compile batch", () => {
    const state = makeState({
      "existing.md": { hash: "h1", concepts: ["shared-concept"] },
    });
    const extractions: ExtractionResult[] = [
      {
        sourceFile: "new.md",
        sourcePath: "/tmp/new.md",
        sourceContent: "content",
        concepts: [{ concept: "Shared Concept", summary: "s", is_new: false }],
      },
    ];
    const toCompile: SourceChange[] = [
      { file: "new.md", status: "new" },
      { file: "existing.md", status: "changed" },
    ];
    const affected = findLateAffectedSources(extractions, state, toCompile);
    expect(affected).toEqual([]);
  });

  it("excludes deleted sources from late-affected set", () => {
    const state = makeState({
      "deleted.md": { hash: "h1", concepts: ["shared-concept"] },
      "existing.md": { hash: "h2", concepts: ["shared-concept"] },
    });
    const extractions: ExtractionResult[] = [
      {
        sourceFile: "new.md",
        sourcePath: "/tmp/new.md",
        sourceContent: "content",
        concepts: [{ concept: "Shared Concept", summary: "s", is_new: false }],
      },
    ];
    const changes: SourceChange[] = [
      { file: "new.md", status: "new" },
      { file: "deleted.md", status: "deleted" },
    ];
    const affected = findLateAffectedSources(extractions, state, changes);
    expect(affected).toContain("existing.md");
    expect(affected).not.toContain("deleted.md");
  });

  it("skips concepts the changed source already had in state", () => {
    const state = makeState({
      "changed.md": { hash: "h1", concepts: ["concept-a"] },
      "unchanged.md": { hash: "h2", concepts: ["concept-a"] },
    });
    const extractions: ExtractionResult[] = [
      {
        sourceFile: "changed.md",
        sourcePath: "/tmp/changed.md",
        sourceContent: "content",
        concepts: [{ concept: "Concept A", summary: "s", is_new: false }],
      },
    ];
    const changes: SourceChange[] = [
      { file: "changed.md", status: "changed" },
      { file: "unchanged.md", status: "unchanged" },
    ];
    // concept-a was already in changed.md's state, so not "freshly gained"
    const affected = findLateAffectedSources(extractions, state, changes);
    expect(affected).toEqual([]);
  });

  it("catches unchanged sources when a changed source gains a new concept", () => {
    const state = makeState({
      "changed.md": { hash: "h1", concepts: ["old-concept"] },
      "bystander.md": { hash: "h2", concepts: ["new-concept"] },
    });
    const extractions: ExtractionResult[] = [
      {
        sourceFile: "changed.md",
        sourcePath: "/tmp/changed.md",
        sourceContent: "content",
        concepts: [
          { concept: "Old Concept", summary: "s", is_new: false },
          { concept: "New Concept", summary: "s", is_new: false },
        ],
      },
    ];
    const changes: SourceChange[] = [
      { file: "changed.md", status: "changed" },
      { file: "bystander.md", status: "unchanged" },
    ];
    // changed.md newly gained "new-concept", which bystander.md owns
    const affected = findLateAffectedSources(extractions, state, changes);
    expect(affected).toEqual(["bystander.md"]);
  });

  it("walks the full co-owner graph from a late-discovered owner", () => {
    const state = makeState({
      "b.md": { hash: "h1", concepts: ["x", "y"] },
      "c.md": { hash: "h2", concepts: ["y"] },
    });
    const extractions: ExtractionResult[] = [{
      sourceFile: "new.md",
      sourcePath: "/tmp/new.md",
      sourceContent: "content",
      concepts: [{ concept: "X", summary: "s", is_new: true }],
    }];
    const changes: SourceChange[] = [{ file: "new.md", status: "new" }];

    expect(findLateAffectedSources(extractions, state, changes)).toEqual(["b.md", "c.md"]);
  });
});

describe("findSharedConcepts", () => {
  it("identifies concepts owned by multiple sources", () => {
    const state = makeState({
      "a.md": { hash: "h1", concepts: ["shared", "only-a"] },
      "b.md": { hash: "h2", concepts: ["shared"] },
    });
    const shared = findSharedConcepts("a.md", state);
    expect(shared.has("shared")).toBe(true);
    expect(shared.has("only-a")).toBe(false);
  });

  it("returns empty set for unknown source", () => {
    const state = makeState({
      "a.md": { hash: "h1", concepts: ["concept"] },
    });
    expect(findSharedConcepts("unknown.md", state).size).toBe(0);
  });

  it("returns empty set when no concepts are shared", () => {
    const state = makeState({
      "a.md": { hash: "h1", concepts: ["only-a"] },
      "b.md": { hash: "h2", concepts: ["only-b"] },
    });
    expect(findSharedConcepts("a.md", state).size).toBe(0);
  });
});
