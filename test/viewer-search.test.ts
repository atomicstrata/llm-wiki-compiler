/**
 * Server-side search semantics — `src/viewer/search.ts`.
 *
 * Covers the spec's §Slice 5 "Search semantics" block: case-insensitive,
 * whitespace-tokenized, multi-token AND, title-before-body ranking,
 * 200-char query cap, 50-result cap, concept and query pages only
 * (no `wiki/index.md`), and the body-snippet shape.
 */

import { describe, it, expect } from "vitest";
import { searchPages } from "../src/viewer/search.js";
import type {
  PageId,
  ViewerPage,
  ViewerSnapshot,
} from "../src/viewer/types.js";

function buildPage(
  slug: string,
  title: string,
  body: string,
  pageDirectory: "concepts" | "queries" = "concepts",
): ViewerPage {
  return {
    id: `${pageDirectory}/${slug}` as PageId,
    slug,
    pageDirectory,
    title,
    filePath: `/tmp/${slug}.md`,
    frontmatter: {},
    body,
    outgoingLinks: [],
    citations: [],
    warnings: [],
  };
}

function buildSnapshot(pages: ViewerPage[]): ViewerSnapshot {
  return {
    root: "/tmp/wiki",
    generatedAt: "2026-05-12T00:00:00.000Z",
    project: { title: "test", rootName: "test" },
    counts: {
      concepts: pages.filter((p) => p.pageDirectory === "concepts").length,
      queries: pages.filter((p) => p.pageDirectory === "queries").length,
      sourceFiles: 0,
      pendingReviews: 0,
      compiledSources: 0,
    },
    index: { available: false, href: "/#/index", body: "", outgoingLinks: [] },
    recentPages: [],
    pages,
    sourceFilenames: [],
  };
}

describe("searchPages — empty and edge cases", () => {
  it("returns no results for an empty query", () => {
    const snapshot = buildSnapshot([buildPage("a", "Alpha", "body")]);
    expect(searchPages(snapshot, "").results).toEqual([]);
  });

  it("returns no results for a whitespace-only query", () => {
    const snapshot = buildSnapshot([buildPage("a", "Alpha", "body")]);
    expect(searchPages(snapshot, "   \t  ").results).toEqual([]);
  });

  it("returns no results when no token matches any page", () => {
    const snapshot = buildSnapshot([buildPage("a", "Alpha", "body of alpha")]);
    expect(searchPages(snapshot, "nonexistent").results).toEqual([]);
  });
});

describe("searchPages — case-insensitive + tokenization", () => {
  it("matches title case-insensitively", () => {
    const snapshot = buildSnapshot([buildPage("a", "Attention", "body")]);
    expect(searchPages(snapshot, "ATTENTION").results).toHaveLength(1);
    expect(searchPages(snapshot, "attention").results).toHaveLength(1);
  });

  it("splits the query on any whitespace and runs multi-token AND", () => {
    // Page b's body intentionally lacks the second token entirely, so
    // it fails the per-token union check even though its title matches
    // the first token. Multiple runs of whitespace collapse to one.
    const pages = [
      buildPage("a", "Alpha Beta", "irrelevant"),
      buildPage("b", "Alpha", "no second token here"),
    ];
    const snapshot = buildSnapshot(pages);
    const results = searchPages(snapshot, "alpha   beta").results;
    expect(results.map((r) => r.id)).toEqual(["concepts/a"]);
  });

  it("a token may match in either title or body to satisfy AND", () => {
    const pages = [
      buildPage("mixed", "Alpha", "introduction with beta gamma"),
    ];
    const snapshot = buildSnapshot(pages);
    // `alpha` matches the title, `beta` matches the body — every token
    // satisfied across the page's title-OR-body union.
    const results = searchPages(snapshot, "alpha beta").results;
    expect(results.map((r) => r.id)).toEqual(["concepts/mixed"]);
  });
});

describe("searchPages — ranking and matchedIn", () => {
  it("ranks title matches before body matches", () => {
    const pages = [
      buildPage("body-only", "Other Title", "this page mentions attention only in body"),
      buildPage("title-hit", "Attention Mechanism", "unrelated body"),
    ];
    const snapshot = buildSnapshot(pages);
    const results = searchPages(snapshot, "attention").results;
    expect(results.map((r) => r.id)).toEqual([
      "concepts/title-hit",
      "concepts/body-only",
    ]);
    expect(results[0].matchedIn).toBe("title");
    expect(results[1].matchedIn).toBe("body");
  });
});

describe("searchPages — snippet shape", () => {
  it("uses the full title as the snippet for title hits", () => {
    const snapshot = buildSnapshot([buildPage("a", "Attention Mechanism", "x")]);
    const results = searchPages(snapshot, "attention").results;
    expect(results[0].snippet).toBe("Attention Mechanism");
  });

  it("extracts ±60 chars around the first body match with ellipsis trimming", () => {
    const longBody =
      "x".repeat(120) +
      " keyword anchor "
      + "y".repeat(120);
    const snapshot = buildSnapshot([buildPage("p", "Unrelated", longBody)]);
    const results = searchPages(snapshot, "keyword").results;
    expect(results).toHaveLength(1);
    expect(results[0].matchedIn).toBe("body");
    // Snippet must contain `keyword` and be ellipsis-fenced because the
    // window was truncated at both ends of the 256-char body.
    expect(results[0].snippet).toContain("keyword");
    expect(results[0].snippet.startsWith("…")).toBe(true);
    expect(results[0].snippet.endsWith("…")).toBe(true);
  });

  it("omits the prefix ellipsis when the match is at the start of the body", () => {
    const body = "keyword starts the body " + "y".repeat(80);
    const snapshot = buildSnapshot([buildPage("p", "Unrelated", body)]);
    const results = searchPages(snapshot, "keyword").results;
    expect(results[0].snippet.startsWith("…")).toBe(false);
    expect(results[0].snippet.endsWith("…")).toBe(true);
  });

  it("strips bold/italic/code markers from body snippets", () => {
    const snippet = snippetForBody(
      "Some prose with **bold** keyword and `inline code` plus _italic_ text.",
    );
    expect(snippet).toContain("bold");
    expect(snippet).toContain("keyword");
    expect(snippet).toContain("inline code");
    expect(snippet).toContain("italic");
    expect(snippet).not.toContain("**");
    expect(snippet).not.toContain("`");
    // Italic underscores are stripped (the regex avoids `snake_case`).
    expect(snippet).not.toContain("_italic_");
  });

  it("strips markdown link syntax in snippets, keeping only the visible label", () => {
    const snippet = snippetForBody(
      "See [the keyword paper](https://example.com/long-url) for context.",
    );
    expect(snippet).toContain("the keyword paper");
    expect(snippet).not.toContain("https://example.com/long-url");
    expect(snippet).not.toContain("](");
  });

  it("strips wiki-link brackets in snippets, keeping aliases when present", () => {
    const snippet = snippetForBody(
      "Related to [[Keyword Topic|the keyword topic]] and [[OpenAI]].",
    );
    expect(snippet).toContain("the keyword topic");
    expect(snippet).toContain("OpenAI");
    expect(snippet).not.toContain("[[");
    expect(snippet).not.toContain("]]");
  });
});

/** Convenience for snippet-cleanup tests: search "keyword" against one body. */
function snippetForBody(body: string): string {
  const snapshot = buildSnapshot([buildPage("p", "Unrelated", body)]);
  return searchPages(snapshot, "keyword").results[0].snippet;
}

describe("searchPages — caps", () => {
  it("caps the query at 200 characters", () => {
    // 200 x 'a' would tokenize as one giant token. 250 x 'a' should still
    // produce the same token (truncated at 200), so a page whose body
    // contains 200+ `a`s in a row matches.
    const snapshot = buildSnapshot([buildPage("p", "Unrelated", "a".repeat(220))]);
    const results = searchPages(snapshot, "a".repeat(250)).results;
    expect(results).toHaveLength(1);
  });

  it("caps the result list at 50 entries", () => {
    const pages: ViewerPage[] = [];
    for (let i = 0; i < 75; i += 1) pages.push(buildPage(`p${i}`, `Topic ${i}`, "body alpha"));
    const snapshot = buildSnapshot(pages);
    const results = searchPages(snapshot, "alpha").results;
    expect(results).toHaveLength(50);
  });
});

describe("searchPages — scope", () => {
  it("searches concept and query pages, not wiki/index.md (it is not in snapshot.pages)", () => {
    const pages = [
      buildPage("c", "Concept Page", "alpha body", "concepts"),
      buildPage("q", "Query Page", "alpha body", "queries"),
    ];
    const snapshot = buildSnapshot(pages);
    snapshot.index = {
      available: true,
      href: "/#/index",
      body: "# Index\nalpha mentioned here too",
      outgoingLinks: [],
    };
    const results = searchPages(snapshot, "alpha").results;
    // Both concept and query pages match; the index body is NEVER
    // searched because it is not included in `snapshot.pages`.
    expect(results.map((r) => r.id).sort()).toEqual(["concepts/c", "queries/q"]);
  });
});
