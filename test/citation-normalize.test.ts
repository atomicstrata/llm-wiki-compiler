/**
 * Unit tests for `normalizeCitationsInBody` and `normalizeCitations`.
 *
 * Verifies that the compile-time normalizer repairs, drops, or passes through
 * citation markers so the resulting page body produces ZERO viewer warnings
 * when processed by `appendCitationWarningsForMarker` / `isMalformedCitationEntry`.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeCitationsInBody,
  normalizeCitations,
} from "../src/compiler/citation-normalize.js";
import { makeNumberedContent } from "./fixtures/citation-content.js";

// Alias for brevity in this test file.
const makeContent = makeNumberedContent;

// ---------------------------------------------------------------------------
// Single-source bare line repair
// ---------------------------------------------------------------------------

describe("normalizeCitationsInBody — single source, bare line", () => {
  it("repairs ^[81] to ^[source.md:81] when line 81 exists in combinedContent", () => {
    const source = "andrej-karpathy.md";
    const content = makeContent(source, 100);
    const body = "Some claim.^[81]";
    const result = normalizeCitationsInBody(body, [source], content);
    expect(result).toBe(`Some claim.^[${source}:81]`);
  });

  it("drops ^[81] when source only has 40 lines (hallucinated line)", () => {
    const source = "short.md";
    const content = makeContent(source, 40);
    const body = "Some claim.^[81]";
    const result = normalizeCitationsInBody(body, [source], content);
    expect(result).toBe("Some claim.");
  });

  it("repairs a range ^[81-90] to ^[source.md:81-90] when max line >= 90", () => {
    const source = "doc.md";
    const content = makeContent(source, 100);
    const body = "Paragraph.^[81-90]";
    const result = normalizeCitationsInBody(body, [source], content);
    expect(result).toBe(`Paragraph.^[${source}:81-90]`);
  });

  it("drops a range when the end exceeds max line", () => {
    const source = "doc.md";
    const content = makeContent(source, 50);
    const body = "Paragraph.^[81-90]";
    const result = normalizeCitationsInBody(body, [source], content);
    expect(result).toBe("Paragraph.");
  });
});

// ---------------------------------------------------------------------------
// The exact user case: repeated occurrence in one body
// ---------------------------------------------------------------------------

describe("normalizeCitationsInBody — repeated marker occurrence", () => {
  it("normalises both occurrences of ^[81] in a body with two paragraphs", () => {
    const source = "neural-nets.md";
    const content = makeContent(source, 120);
    const body = [
      "First fact.^[81]",
      "",
      "Second fact, also capable.^[81]",
    ].join("\n");
    const result = normalizeCitationsInBody(body, [source], content);
    const repaired = `^[${source}:81]`;
    expect(result).toContain(`First fact.${repaired}`);
    expect(result).toContain(`Second fact, also capable.${repaired}`);
  });
});

// ---------------------------------------------------------------------------
// Multi-source: bare number must be dropped (ambiguous)
// ---------------------------------------------------------------------------

describe("normalizeCitationsInBody — multi-source bare number", () => {
  it("drops ^[81] when there are two sources (ambiguous)", () => {
    const sources = ["a.md", "b.md"];
    const content =
      makeContent("a.md", 100) + "\n\n" + makeContent("b.md", 100);
    const body = "Claim.^[81]";
    const result = normalizeCitationsInBody(body, sources, content);
    expect(result).toBe("Claim.");
  });
});

// ---------------------------------------------------------------------------
// Valid citation — untouched
// ---------------------------------------------------------------------------

describe("normalizeCitationsInBody — valid citations pass through", () => {
  it("leaves ^[andrej-karpathy.md:1-5] unchanged", () => {
    const source = "andrej-karpathy.md";
    const content = makeContent(source, 50);
    const body = `Neural scaling.^[${source}:1-5]`;
    const result = normalizeCitationsInBody(body, [source], content);
    expect(result).toBe(body);
  });

  it("leaves ^[file.md] (paragraph-form, no range) unchanged", () => {
    const source = "notes.md";
    const content = makeContent(source, 10);
    const body = "A claim.^[notes.md]";
    const result = normalizeCitationsInBody(body, [source], content);
    expect(result).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// Mixed marker: one valid entry + one bare entry
// ---------------------------------------------------------------------------

describe("normalizeCitationsInBody — mixed marker", () => {
  it("keeps valid andrej-karpathy.md:1-5 and drops bare 99 (two sources, ambiguous)", () => {
    const sources = ["andrej-karpathy.md", "other.md"];
    const content =
      makeContent("andrej-karpathy.md", 20) + "\n\n" + makeContent("other.md", 20);
    const body = "Claim.^[andrej-karpathy.md:1-5, 99]";
    const result = normalizeCitationsInBody(body, sources, content);
    expect(result).toBe("Claim.^[andrej-karpathy.md:1-5]");
  });

  it("keeps valid entry and repairs bare number in single-source mixed marker", () => {
    const source = "src.md";
    const content = makeContent(source, 100);
    const body = "Claim.^[src.md:1-5, 81]";
    const result = normalizeCitationsInBody(body, [source], content);
    expect(result).toBe(`Claim.^[src.md:1-5, ${source}:81]`);
  });
});

// ---------------------------------------------------------------------------
// Unknown filename entries — kept for provenance linter
// ---------------------------------------------------------------------------

describe("normalizeCitationsInBody — unknown filename entries", () => {
  it("keeps ^[ghost.md:1-5] unchanged so the provenance linter can flag broken-citation", () => {
    const source = "real.md";
    const content = makeContent(source, 10);
    const body = "Claim.^[ghost.md:1-5]";
    const result = normalizeCitationsInBody(body, [source], content);
    // The marker is preserved as-is — the downstream linter owns broken-citation.
    expect(result).toBe("Claim.^[ghost.md:1-5]");
  });

  it("keeps ^[does-not-exist.md] unchanged (unresolvable file, linter's job)", () => {
    const source = "real.md";
    const content = makeContent(source, 10);
    const body = "Claim.^[does-not-exist.md]";
    const result = normalizeCitationsInBody(body, [source], content);
    expect(result).toBe("Claim.^[does-not-exist.md]");
  });
});

// ---------------------------------------------------------------------------
// No-survivor marker: entire marker removed, no dangling space
// ---------------------------------------------------------------------------

describe("normalizeCitationsInBody — no-survivor marker removal", () => {
  it("removes the marker and collapses the preceding space when no entries survive", () => {
    const source = "src.md";
    const content = makeContent(source, 10);
    const body = "word ^[999]";
    const result = normalizeCitationsInBody(body, [source], content);
    expect(result).toBe("word");
  });

  it("removes adjacent marker with no space before it", () => {
    const source = "src.md";
    const content = makeContent(source, 10);
    const body = "word^[999]";
    const result = normalizeCitationsInBody(body, [source], content);
    expect(result).toBe("word");
  });
});

// ---------------------------------------------------------------------------
// Sentinel isolation: normalizeCitations (internal) returns sentinel for removal
// ---------------------------------------------------------------------------

describe("normalizeCitations — sentinel for dropped markers", () => {
  it("replaces dropped marker with sentinel (internal check)", () => {
    const source = "x.md";
    const content = makeContent(source, 5);
    const raw = normalizeCitations("word^[99]", [source], content);
    expect(raw).toContain("\x00REMOVED\x00");
  });
});
