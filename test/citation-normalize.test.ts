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
import { checkPageMalformedCitations } from "../src/linter/rules-citations.js";
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
  it("keeps ^[andrej-karpathy.md:1-5, 99] as-is (comma-continuation stays together after splitCitationMarker)", () => {
    const sources = ["andrej-karpathy.md", "other.md"];
    const content =
      makeContent("andrej-karpathy.md", 20) + "\n\n" + makeContent("other.md", 20);
    // splitCitationMarker keeps ", 99" attached to the file entry (99 is a line continuation),
    // so the whole entry has a valid file prefix and is preserved unchanged.
    const body = "Claim.^[andrej-karpathy.md:1-5, 99]";
    const result = normalizeCitationsInBody(body, sources, content);
    expect(result).toBe("Claim.^[andrej-karpathy.md:1-5, 99]");
  });

  it("keeps ^[src.md:1-5, 81] as-is in single-source marker (comma-continuation, not a separate bare entry)", () => {
    const source = "src.md";
    const content = makeContent(source, 100);
    // splitCitationMarker keeps ", 81" attached to src.md:1-5 (digit after comma = line continuation),
    // so normalizeEntry sees a valid file prefix and returns the full entry unchanged.
    const body = "Claim.^[src.md:1-5, 81]";
    const result = normalizeCitationsInBody(body, [source], content);
    expect(result).toBe("Claim.^[src.md:1-5, 81]");
  });

  it("drops truly bare number from a multi-source marker when separated by a non-digit file entry", () => {
    const sources = ["a.md", "b.md"];
    const content = makeContent("a.md", 20) + "\n\n" + makeContent("b.md", 20);
    // splitCitationMarker DOES split before "b.md" (starts with letter), so "99" in
    // "a.md:1-5, b.md" is not the issue; a standalone bare number AFTER a file stays bare.
    // Use a marker where the bare number is clearly separated: ^[a.md:1-5, b.md, 99]
    // The last ",99" — 99 is a digit at end → stays attached to "b.md"? No: "b.md, 99"
    // splits at the comma before "b.md" (b is not a digit), leaving "b.md, 99" as one token.
    // Instead test a plain bare number alongside a valid file without comma-continuation:
    // ^[99, a.md:1-5] — "99" followed by ", a.md:1-5"; the comma before "a.md" splits
    // (a is not a digit), so entries are ["99", " a.md:1-5"]. 99 is multi-source → dropped.
    const body = "Claim.^[99, a.md:1-5]";
    const result = normalizeCitationsInBody(body, sources, content);
    expect(result).toBe("Claim.^[a.md:1-5]");
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

  it("drops unknown entries only when a clean rebuild requests strict sources", () => {
    const source = "real.md";
    const content = makeContent(source, 10);
    const body = "Claim.^[real.md:1-2, deleted.md:3-4]";
    const result = normalizeCitationsInBody(body, [source], content, true);
    expect(result).toBe("Claim.^[real.md:1-2]");
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

// ---------------------------------------------------------------------------
// Bug 1 regression: comma-continuation citations must not be split
// ---------------------------------------------------------------------------

describe("normalizeCitationsInBody — comma-continuation citation preserved", () => {
  it("keeps ^[source.md:1, 12] unchanged on a single-source page", () => {
    const source = "source.md";
    const content = makeContent(source, 20);
    const body = `Claim.^[${source}:1, 12]`;
    const result = normalizeCitationsInBody(body, [source], content);
    expect(result).toBe(body);
  });

  it("keeps ^[source.md:1, 12] unchanged on a multi-source page", () => {
    const sources = ["source.md", "other.md"];
    const content = makeContent("source.md", 20) + "\n\n" + makeContent("other.md", 20);
    const body = "Claim.^[source.md:1, 12]";
    const result = normalizeCitationsInBody(body, sources, content);
    expect(result).toBe(body);
  });

  it("keeps ^[a.md:1-5, 12] unchanged (file with line list)", () => {
    const source = "a.md";
    const content = makeContent(source, 20);
    const body = `Claim.^[${source}:1-5, 12]`;
    const result = normalizeCitationsInBody(body, [source], content);
    expect(result).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// Bug 2 regression: backward bare ranges must be dropped, not repaired
// ---------------------------------------------------------------------------

describe("normalizeCitationsInBody — backward range handling", () => {
  it("drops ^[90-81] on a single-source page (backward range is invalid)", () => {
    const source = "source.md";
    const content = makeContent(source, 100);
    const body = "Claim. ^[90-81]";
    const result = normalizeCitationsInBody(body, [source], content);
    expect(result).toBe("Claim.");
  });

  it("repairs ^[81, 90] to ^[source.md:81, 90] when both lines exist", () => {
    const source = "source.md";
    const content = makeContent(source, 100);
    const body = "Claim.^[81, 90]";
    const result = normalizeCitationsInBody(body, [source], content);
    expect(result).toBe(`Claim.^[${source}:81, 90]`);
  });
});

// ---------------------------------------------------------------------------
// Drift guard: citations the normalizer is allowed to emit must pass the validator
// ---------------------------------------------------------------------------

describe("normalizer output is always accepted by the malformed-citation validator", () => {
  const source = "source.md";
  const rawShapes = [
    "^[7]",
    "^[3-9]",
    "^[12,15,20]",
    "^[1-5, 12]",
    "^[1, 12-15]",
    // The normalizer's bare-line pattern tolerates space on both sides of the
    // comma, so the validator has to accept what that repairs into.
    "^[81 , 90]",
    "^[1-5 , 12]",
    `^[${source}:4]`,
    `^[${source}:4-8]`,
    `^[${source}:12,15,20]`,
    `^[${source}:1, 12-15]`,
    `^[${source}:81 , 90]`,
    `^[${source}#L2-L6]`,
  ];

  it.each(rawShapes)("normalized %s yields no malformed-citation findings", (marker) => {
    const content = makeContent(source, 100);
    const body = `Claim.${marker}`;
    const result = normalizeCitationsInBody(body, [source], content);
    expect(checkPageMalformedCitations(result, "wiki/concepts/test.md")).toEqual([]);
  });

  it("multi-source marker normalizes to validator-clean entries", () => {
    const sources = ["a.md", "b.md"];
    const content = makeContent("a.md", 50) + "\n\n" + makeContent("b.md", 50);
    const body = "Claim.^[a.md:1-5, b.md:10]";
    const result = normalizeCitationsInBody(body, sources, content);
    expect(checkPageMalformedCitations(result, "wiki/concepts/test.md")).toEqual([]);
  });
});
