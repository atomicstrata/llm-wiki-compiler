/**
 * Unit tests for the page prompt's ordering: shared content first, per-page
 * content last.
 *
 * Pages drawn from the same sources receive the same instructions and source
 * material, so those must form an identical prefix; the concept, existing page
 * and related pages differ per page and must all come after the source
 * material's end marker, so wiki context is never read as source. The prompt
 * must still name the concept, and keep every per-page part it carried before.
 */

import { describe, it, expect } from "vitest";
import { buildPagePrompt } from "../src/compiler/prompts.js";

const SOURCE = "--- SOURCE: notes.md ---\n\n1 | Shared source text about caching.";
const SOURCE_MARKER = "--- SOURCE MATERIAL ---";
const END_MARKER = "--- END SOURCE MATERIAL ---";

/** Length of the common prefix of two strings. */
function commonPrefixLength(a: string, b: string): number {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return index;
}

describe("buildPagePrompt ordering", () => {
  it("gives two pages from the same source an identical prefix through the source end marker", () => {
    const first = buildPagePrompt("Alpha Concept", SOURCE, "", "related alpha");
    const second = buildPagePrompt("Beta Concept", SOURCE, "existing beta", "related beta");
    const sharedEnd = first.indexOf(END_MARKER) + END_MARKER.length;
    expect(first.indexOf(SOURCE)).toBeGreaterThan(first.indexOf(SOURCE_MARKER));
    expect(first.indexOf(END_MARKER)).toBeGreaterThan(first.indexOf(SOURCE));
    expect(commonPrefixLength(first, second)).toBeGreaterThanOrEqual(sharedEnd);
  });

  it("closes the source material, then places the concept, existing page and related pages", () => {
    const prompt = buildPagePrompt("Alpha Concept", SOURCE, "EXISTING-BODY", "RELATED-BODY");
    const sourceEnd = prompt.indexOf(SOURCE) + SOURCE.length;
    const endMarker = prompt.indexOf(END_MARKER);
    expect(endMarker).toBeGreaterThanOrEqual(sourceEnd);
    for (const perPage of ['"Alpha Concept"', "EXISTING-BODY", "RELATED-BODY"]) {
      expect(prompt.indexOf(perPage)).toBeGreaterThan(endMarker);
    }
    expect(prompt.slice(0, sourceEnd)).not.toContain("Alpha Concept");
  });

  it("still names the concept and omits empty per-page sections", () => {
    const prompt = buildPagePrompt("Alpha Concept", SOURCE, "", "");
    expect(prompt).toContain('Concept to write about: "Alpha Concept".');
    expect(prompt).not.toContain("Existing page to update:");
    expect(prompt).not.toContain("Related wiki pages for cross-referencing:");
  });
});
