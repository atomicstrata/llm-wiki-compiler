/**
 * Happy-path tests for `renderPageHtml` — markdown to sanitized HTML.
 *
 * Covers the rendering features the spec's Slice 4 acceptance criteria
 * call out: headings, lists, code blocks, tables, resolved wikilinks,
 * unresolved wikilinks, and citation chips for each of the three
 * supported span shapes.
 */

import { describe, it, expect } from "vitest";
import { renderPageHtml } from "../src/viewer/render.js";
import type {
  PageId,
  ViewerPage,
  ViewerSnapshot,
} from "../src/viewer/types.js";

function buildPage(slug: string, title: string): ViewerPage {
  return {
    id: `concepts/${slug}` as PageId,
    slug,
    pageDirectory: "concepts",
    title,
    filePath: `/tmp/${slug}.md`,
    frontmatter: {},
    body: "",
    outgoingLinks: [],
    citations: [],
    warnings: [],
  };
}

function buildSnapshot(pages: ViewerPage[], sourceFilenames: string[] = []): ViewerSnapshot {
  return {
    root: "/tmp/wiki",
    generatedAt: "2026-05-12T00:00:00.000Z",
    project: { title: "test-wiki", rootName: "test-wiki" },
    counts: {
      concepts: pages.filter((p) => p.pageDirectory === "concepts").length,
      queries: pages.filter((p) => p.pageDirectory === "queries").length,
      sourceFiles: sourceFilenames.length,
      pendingReviews: 0,
      compiledSources: 0,
    },
    index: { available: false, href: "/#/index", body: "", outgoingLinks: [] },
    recentPages: [],
    pages,
    sourceFilenames,
  };
}

describe("renderPageHtml — core markdown", () => {
  it("renders headings, paragraphs, and bold/italic", () => {
    const snapshot = buildSnapshot([]);
    const { html } = renderPageHtml(
      "# Title\n\nA paragraph with **bold** and *italic*.",
      snapshot,
      { isLoopback: true },
    );
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
  });

  it("renders unordered lists and ordered lists", () => {
    const snapshot = buildSnapshot([]);
    const { html } = renderPageHtml(
      "- one\n- two\n\n1. first\n2. second",
      snapshot,
      { isLoopback: true },
    );
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>first</li>");
  });

  it("renders fenced code blocks and inline code", () => {
    const snapshot = buildSnapshot([]);
    const { html } = renderPageHtml(
      "Inline `code` here.\n\n```\nfenced block\n```",
      snapshot,
      { isLoopback: true },
    );
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<pre>");
    expect(html).toContain("fenced block");
  });

  it("renders tables", () => {
    const snapshot = buildSnapshot([]);
    const { html } = renderPageHtml(
      "| a | b |\n| - | - |\n| 1 | 2 |",
      snapshot,
      { isLoopback: true },
    );
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
  });
});

describe("renderPageHtml — wikilinks", () => {
  it("renders a resolved [[slug]] as a hash-routed anchor with data-page-id", () => {
    const pages = [buildPage("alpha", "Alpha")];
    const { html } = renderPageHtml("See [[alpha]] now.", buildSnapshot(pages), { isLoopback: true });
    expect(html).toContain('data-page-id="concepts/alpha"');
    expect(html).toContain('href="#/concepts/alpha"');
    expect(html).toContain(">alpha</a>");
  });

  it("uses the alias label for [[slug|alias]]", () => {
    const pages = [buildPage("alpha", "Alpha")];
    const { html } = renderPageHtml(
      "See [[alpha|the alpha one]].",
      buildSnapshot(pages),
      { isLoopback: true },
    );
    expect(html).toContain(">the alpha one</a>");
  });

  it("renders an unresolved [[ghost]] as data-missing=true", () => {
    const { html } = renderPageHtml("See [[ghost]].", buildSnapshot([]), { isLoopback: true });
    expect(html).toContain('data-missing="true"');
    expect(html).toContain("[[ghost]]");
  });
});

describe("renderPageHtml — citation chips", () => {
  it("renders one chip per span for ^[a.md, b.md]", () => {
    const snapshot = buildSnapshot([], ["a.md", "b.md"]);
    const { html } = renderPageHtml("Claim ^[a.md, b.md].", snapshot, { isLoopback: true });
    const chips = html.match(/<span class="citation-chip"/g) ?? [];
    expect(chips.length).toBe(2);
    expect(html).toContain('data-file="a.md"');
    expect(html).toContain('data-file="b.md"');
  });

  it("parses the colon span form: ^[c.md:42-58] → data-line-start/end", () => {
    const snapshot = buildSnapshot([], ["c.md"]);
    const { html } = renderPageHtml("Quote ^[c.md:42-58].", snapshot, { isLoopback: true });
    expect(html).toContain('data-file="c.md"');
    expect(html).toContain('data-line-start="42"');
    expect(html).toContain('data-line-end="58"');
    expect(html).toContain("c.md:42-58");
  });

  it("parses the hash span form: ^[c.md#L42-L58] → same line attributes", () => {
    const snapshot = buildSnapshot([], ["c.md"]);
    const { html } = renderPageHtml("Quote ^[c.md#L42-L58].", snapshot, { isLoopback: true });
    expect(html).toContain('data-line-start="42"');
    expect(html).toContain('data-line-end="58"');
  });

  it("marks unresolved citations with data-resolved=false", () => {
    const snapshot = buildSnapshot([], ["only-this.md"]);
    const { html } = renderPageHtml("Quote ^[ghost.md].", snapshot, { isLoopback: true });
    expect(html).toContain('data-file="ghost.md"');
    expect(html).toContain('data-resolved="false"');
    expect(html).not.toContain('data-absolute-path');
  });

  it("includes editor link and absolute path only on loopback binds", () => {
    const snapshot = buildSnapshot([], ["c.md"]);
    const loopbackHtml = renderPageHtml("Quote ^[c.md:42].", snapshot, { isLoopback: true }).html;
    expect(loopbackHtml).toContain("data-absolute-path");
    expect(loopbackHtml).toContain("data-editor-href");
    expect(loopbackHtml).toContain("vscode://file/");

    const lanHtml = renderPageHtml("Quote ^[c.md:42].", snapshot, { isLoopback: false }).html;
    expect(lanHtml).not.toContain("data-absolute-path");
    expect(lanHtml).not.toContain("data-editor-href");
    expect(lanHtml).not.toContain("vscode://");
  });
});
