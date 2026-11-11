/**
 * The v2 reading features: what a hover preview shows for a wikilink or a
 * citation chip, and the page outline with its scroll-spy rule. The helpers
 * that read the DOM run against a jsdom document built per test, so nothing
 * here touches the globals other test files share.
 */
import { describe, expect, it } from "bun:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { activeHeading, assignHeadingIds, Outline, slugify } from "../viewer-v2/src/outline.js";
import { HoverPreviews } from "../viewer-v2/src/hover-preview.js";
import { decorateChip } from "../viewer-v2/src/wiki-html.js";
import { citedSourceText, findTrigger, isTracked, MAX_EXCERPT_LINES, pageBlurb, pageKindLabel, plainOpening, previewTarget, sliceExcerpt } from "../viewer-v2/src/preview-data.js";
import { envelope, page, text } from "./fixtures/viewer-v2-fixtures.js";

/** A detached document holding `html`. */
function documentWith(html: string): Document {
  return new JSDOM(`<body>${html}</body>`).window.document;
}

const SOURCE = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");

describe("preview targets", () => {
  it("reads a wikilink, a chip inside markup, and a missing-file chip", () => {
    const doc = documentWith(`
      <a class="wikilink" data-page-id="concepts/alpha" href="#/concepts/alpha"><em id="inner">Alpha</em></a>
      <span class="citation-chip" data-file="notes.md" data-resolved="true" data-line-start="3" data-line-end="5">notes.md:3-5</span>
      <span class="citation-chip" data-file="gone.md" data-resolved="false">gone.md</span>
      <p id="plain">plain</p>`);
    expect(previewTarget(findTrigger(doc.getElementById("inner"))!)).toEqual({ kind: "page", id: "concepts/alpha" });
    const [chip, gone] = Array.from(doc.querySelectorAll<HTMLElement>(".citation-chip"));
    expect(previewTarget(chip)).toEqual({ kind: "citation", file: "notes.md", lineStart: 3, lineEnd: 5, resolved: true });
    expect(previewTarget(gone)).toEqual({ kind: "citation", file: "gone.md", resolved: false });
    expect(findTrigger(doc.getElementById("plain"))).toBeNull();
  });
});

describe("preview cards", () => {
  it("labels a page by its type or directory and prefers the row summary", async () => {
    const row = page({ id: "concepts/alpha", summary: "Alpha in brief." });
    expect(pageKindLabel("concepts/alpha", row)).toBe("Concepts");
    expect(pageKindLabel("papers/p1", undefined)).toBe("Papers");
    expect(await pageBlurb("concepts/alpha", row, "s1")).toBe("Alpha in brief.");
    await expect(citedSourceText({ kind: "citation", file: "gone.md", resolved: false }, "s1")).rejects.toThrow("gone.md");
  });

  it("fetches a cited source once per wiki snapshot, and again after a compile", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => new Response(`v${++calls}`)) as unknown as typeof fetch;
    try {
      const target = { kind: "citation", file: "cache.md", resolved: true } as const;
      expect([await citedSourceText(target, "s1"), await citedSourceText(target, "s1")]).toEqual(["v1", "v1"]);
      expect(await citedSourceText(target, "s2")).toBe("v2");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("treats moving within the open or pending trigger as no change", () => {
    const doc = documentWith('<a data-page-id="a" id="a"></a><a data-page-id="b" id="b"></a>');
    const [a, b] = [doc.getElementById("a"), doc.getElementById("b")];
    expect(isTracked(a, a, null)).toBe(true);
    expect(isTracked(a, null, a)).toBe(true);
    expect(isTracked(b, a, null)).toBe(false);
    expect(isTracked(null, null, null)).toBe(false);
  });

  it("renders nothing until a trigger holds interest", () => {
    expect(renderToStaticMarkup(createElement(HoverPreviews, { wiki: envelope({ pages: [page({ id: "concepts/alpha" })] }) }))).toBe("");
  });
});

describe("citation chips in a page body", () => {
  it("shorten to their range, name the citation in full, and stay links only when the file exists", () => {
    const doc = documentWith(`
      <span class="citation-chip" data-file="notes.md" data-resolved="true" data-line-start="12" data-line-end="15">notes.md:12-15</span>
      <span class="citation-chip" data-file="notes.md" data-resolved="true" data-line-start="7">notes.md:7</span>
      <span class="citation-chip" data-file="gone.md" data-resolved="false">gone.md</span>`);
    const [range, single, gone] = Array.from(doc.querySelectorAll<HTMLElement>(".citation-chip"));
    for (const chip of [range, single, gone]) { decorateChip(chip); decorateChip(chip); }
    expect([range.textContent, range.getAttribute("aria-label"), range.getAttribute("role")]).toEqual(["L12–15", "notes.md, lines 12–15", "link"]);
    expect([single.textContent, single.getAttribute("aria-label")]).toEqual(["L7", "notes.md, line 7"]);
    expect([gone.textContent, gone.getAttribute("role"), gone.getAttribute("tabindex")]).toEqual(["gone.md", null, null]);
  });
});

describe("cited excerpts", () => {
  it("numbers the cited span and caps a long one", () => {
    expect(sliceExcerpt(SOURCE, 3, 5)).toEqual({ lines: [{ number: 3, text: "line 3" }, { number: 4, text: "line 4" }, { number: 5, text: "line 5" }], hiddenCount: 0 });
    const long = sliceExcerpt(SOURCE, 2, 25);
    expect(long.lines).toHaveLength(MAX_EXCERPT_LINES);
    expect(long.lines[0].number).toBe(2);
    expect(long.hiddenCount).toBe(24 - MAX_EXCERPT_LINES);
  });

  it("shows one line for a single-line cite, the opening for a whole file, and stops at the file end", () => {
    expect(sliceExcerpt(SOURCE, 7, 7).lines).toEqual([{ number: 7, text: "line 7" }]);
    expect(sliceExcerpt(SOURCE).lines.map((line) => line.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(sliceExcerpt(SOURCE, 29, 40)).toEqual({ lines: [{ number: 29, text: "line 29" }, { number: 30, text: "line 30" }], hiddenCount: 0 });
    expect(sliceExcerpt(SOURCE, 40, 42).lines).toEqual([]);
  });
});

describe("page openings", () => {
  it("takes the first paragraph as text, without citation chips, and cuts at a word", () => {
    const html = '<h2>Head</h2><p>Tom &amp; <a href="#">Jerry</a> met.<span class="citation-chip" data-file="a.md">a.md:1</span></p><p>Second.</p>';
    expect(plainOpening(html)).toBe("Tom & Jerry met.");
    expect(plainOpening("<p>one two three four</p>", 9)).toBe("one two…");
    expect(plainOpening("<ul><li>no paragraph</li></ul>")).toBe("");
  });
});

describe("outline", () => {
  it("gives headings unique prefixed ids in document order", () => {
    const doc = documentWith("<h2>Intro</h2><h3>Café notes</h3><h2>Intro</h2><h4>skipped</h4><h2>!!!</h2>");
    expect(assignHeadingIds(doc.body)).toEqual([
      { id: "h-intro", text: "Intro", level: 2 },
      { id: "h-cafe-notes", text: "Café notes", level: 3 },
      { id: "h-intro-2", text: "Intro", level: 2 },
      { id: "h-section", text: "!!!", level: 2 },
    ]);
    expect(doc.querySelector("h3")?.id).toBe("h-cafe-notes");
    expect(slugify("  Hello, World  ")).toBe("hello-world");
  });

  it("highlights the last heading past the line, the last at the page end, and a clicked one", () => {
    const tops = [{ id: "a", top: -40 }, { id: "b", top: 50 }, { id: "c", top: 400 }];
    expect(activeHeading({ tops, atBottom: false, pinned: null })).toBe("b");
    expect(activeHeading({ tops: [{ id: "a", top: 300 }], atBottom: false, pinned: null })).toBe("a");
    expect(activeHeading({ tops, atBottom: true, pinned: null })).toBe("c");
    expect(activeHeading({ tops, atBottom: true, pinned: "b" })).toBe("b");
    expect(activeHeading({ tops: [], atBottom: false, pinned: null })).toBeNull();
  });

  it("renders only for two or more headings, indenting subsections", () => {
    expect(renderToStaticMarkup(createElement(Outline, { items: [{ id: "h-a", text: "A", level: 2 }] }))).toBe("");
    const html = renderToStaticMarkup(createElement(Outline, { items: [{ id: "h-a", text: "A", level: 2 }, { id: "h-b", text: "B", level: 3 }] }));
    expect(text(html)).toBe("On this page A B");
    expect(html).toMatch(/pl-6[^>]*>B</);
  });
});
