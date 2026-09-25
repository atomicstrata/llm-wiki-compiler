/**
 * Page selection must not confuse evidence contributors with changed pages.
 * Pin dropped assignments, frozen failures and complete contributor sets with
 * a transitive chain whose tail should remain untouched.
 */
import { describe, expect, it } from "vitest";
import { mergeExtractions } from "../src/compiler/extraction-merge.js";
import type { ExtractionResult } from "../src/compiler/deps.js";

/** Small source record with predictable metadata and evidence. */
function source(file: string, names: string[], reused?: true): ExtractionResult {
  return { sourceFile: file, sourcePath: file, sourceContent: `Evidence from ${file}`,
    concepts: names.map(concept => ({ concept, summary: concept, is_new: !reused })),
    ...(reused ? { reused } : {}),
  };
}

describe("page generation scope", () => {
  it("does not let a cached co-owner's unrelated assignments expand page work", () => {
    const entries = [source("a.md", ["X"]), source("b.md", ["X", "Y"], true), source("c.md", ["Y", "Z"], true)];
    const pages = mergeExtractions(entries, new Set());
    expect(pages.map(page => page.slug)).toEqual(["x"]);
    expect(pages[0].sourceFiles).toEqual(["a.md", "b.md"]);
    expect(pages[0].combinedContent).toContain("Evidence from b.md");
    expect(pages[0].combinedContent).not.toContain("Evidence from c.md");
  });

  it("keeps prior assignments in scope when fresh extraction drops them", () => {
    const fresh = { ...source("a.md", ["X"]), previousConcepts: ["x", "y"] };
    const pages = mergeExtractions([fresh, source("b.md", ["Y", "Z"], true)], new Set());
    expect(pages.map(page => page.slug)).toEqual(["x", "y"]);
    expect(pages[1].sourceFiles).toEqual(["b.md"]);
  });

  it("never regenerates an affected slug frozen by an extraction failure", () => {
    const entries = [source("a.md", ["X"]), source("b.md", ["X", "Y"], true)];
    expect(mergeExtractions(entries, new Set(["x"]))).toEqual([]);
  });

  it("honors explicit reconciliation even with reused metadata", () => {
    const pages = mergeExtractions([source("b.md", ["X", "Y"], true)], new Set(), new Set(["y"]));
    expect(pages.map(page => page.slug)).toEqual(["y"]);
    expect(pages[0].rebuild).toBe(true);
  });
});
