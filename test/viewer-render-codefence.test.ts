/**
 * Containment matrix for `[[wikilink]]` and `^[source.md]` markers.
 *
 * Closes the spec's Slice 4 #11 audit item: in four contexts the markers
 * must render as LITERAL TEXT, not as wikilinks or citation chips:
 *
 *   1. Inline code spans (backtick-delimited).
 *   2. Fenced code blocks (triple-backtick).
 *   3. Escaped sequences (`\[[…]]`, `\^[…]`).
 *   4. Markdown link text (`[anchor](url)`).
 */

import { describe, it, expect } from "vitest";
import { renderPageHtml } from "../src/viewer/render.js";
import type {
  PageId,
  ViewerPage,
  ViewerSnapshot,
} from "../src/viewer/types.js";

const ALPHA: ViewerPage = {
  id: "concepts/alpha" as PageId,
  slug: "alpha",
  pageDirectory: "concepts",
  title: "Alpha",
  filePath: "/tmp/alpha.md",
  frontmatter: {},
  body: "",
  outgoingLinks: [],
  citations: [],
  warnings: [],
};

const SNAPSHOT: ViewerSnapshot = {
  root: "/tmp/wiki",
  generatedAt: "2026-05-12T00:00:00.000Z",
  project: { title: "t", rootName: "t" },
  counts: { concepts: 1, queries: 0, sourceFiles: 1, pendingReviews: 0, compiledSources: 0 },
  index: { available: false, href: "/#/index", body: "", outgoingLinks: [] },
  recentPages: [],
  pages: [ALPHA],
  sourceFilenames: ["src.md"],
};

function render(markdown: string): string {
  return renderPageHtml(markdown, SNAPSHOT, { isLoopback: true }).html;
}

describe("inline code spans preserve markers as literal", () => {
  it("`[[alpha]]` inside backticks does not become a wikilink anchor", () => {
    const html = render("Use `[[alpha]]` in code.");
    expect(html).not.toMatch(/<a [^>]*data-page-id/);
    expect(html).toContain("[[alpha]]");
  });

  it("`^[src.md]` inside backticks does not become a citation chip", () => {
    const html = render("Marker `^[src.md]` here.");
    expect(html).not.toContain("citation-chip");
    expect(html).toContain("^[src.md]");
  });
});

describe("fenced code blocks preserve markers as literal", () => {
  it("triple-backtick block keeps [[alpha]] and ^[src.md] as text", () => {
    const html = render("```\n[[alpha]] and ^[src.md]\n```");
    expect(html).not.toMatch(/<a [^>]*data-page-id/);
    expect(html).not.toContain("citation-chip");
    expect(html).toContain("[[alpha]]");
    expect(html).toContain("^[src.md]");
  });
});

describe("escaped sequences preserve markers as literal", () => {
  it("\\[[alpha]] does not produce a wikilink anchor", () => {
    const html = render("Type \\[[alpha]] in your editor.");
    expect(html).not.toMatch(/<a [^>]*data-page-id/);
  });

  it("\\^[src.md] does not produce a citation chip", () => {
    const html = render("Type \\^[src.md] in your editor.");
    expect(html).not.toContain("citation-chip");
  });
});

describe("markdown link text preserves markers as literal", () => {
  it("[[alpha]] inside [text](url) does not produce a nested wikilink", () => {
    const html = render("[See [[alpha]] reference](https://example.com)");
    // Exactly one anchor — the outer markdown link. No nested wikilink.
    const anchors = html.match(/<a\s/g) ?? [];
    expect(anchors.length).toBe(1);
    expect(html).not.toMatch(/<a [^>]*data-page-id/);
  });

  it("^[src.md] inside [text](url) does not produce a citation chip", () => {
    const html = render("[Quote ^[src.md] reference](https://example.com)");
    expect(html).not.toContain("citation-chip");
    const anchors = html.match(/<a\s/g) ?? [];
    expect(anchors.length).toBe(1);
  });
});
