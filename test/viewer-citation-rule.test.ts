/**
 * Focused tests for the citation-chip inline rule.
 *
 * Exercises one-chip-per-span emission for multi-source markers and the
 * loopback-only inclusion of `data-absolute-path` / `data-editor-href`
 * per the spec's §Support Rail rules. The render-level integration is
 * covered in `viewer-render.test.ts`; this file targets the parser /
 * chip-emit behavior directly.
 */

import { describe, it, expect } from "vitest";
import { renderPageHtml } from "../src/viewer/render.js";
import type { ViewerSnapshot } from "../src/viewer/types.js";

function buildSnapshot(sourceFilenames: string[]): ViewerSnapshot {
  return {
    root: "/tmp/wiki",
    generatedAt: "2026-05-12T00:00:00.000Z",
    project: { title: "t", rootName: "t" },
    counts: {
      concepts: 0,
      queries: 0,
      sourceFiles: sourceFilenames.length,
      pendingReviews: 0,
      compiledSources: 0,
    },
    index: { available: false, href: "/#/index", body: "", outgoingLinks: [] },
    recentPages: [],
    pages: [],
    sourceFilenames,
  };
}

function chips(html: string): string[] {
  return Array.from(html.matchAll(/<span class="citation-chip"[^>]*>[^<]*<\/span>/g)).map(
    (m) => m[0],
  );
}

describe("citation-rule — chip emission", () => {
  it("emits one chip per comma-separated span in ^[a.md, b.md]", () => {
    const snapshot = buildSnapshot(["a.md", "b.md"]);
    const { html } = renderPageHtml("Cite ^[a.md, b.md].", snapshot, { isLoopback: true });
    expect(chips(html).length).toBe(2);
  });

  it("emits one chip for a single bare-filename marker", () => {
    const snapshot = buildSnapshot(["x.md"]);
    const { html } = renderPageHtml("Cite ^[x.md].", snapshot, { isLoopback: true });
    expect(chips(html).length).toBe(1);
  });

  it("renders the colon line-range form with the range in the visible label", () => {
    const snapshot = buildSnapshot(["c.md"]);
    const { html } = renderPageHtml("^[c.md:42-58]", snapshot, { isLoopback: true });
    expect(html).toContain("c.md:42-58");
    expect(html).toContain('data-line-start="42"');
    expect(html).toContain('data-line-end="58"');
  });

  it("renders the hash line-range form with identical line attributes", () => {
    const snapshot = buildSnapshot(["c.md"]);
    const { html } = renderPageHtml("^[c.md#L42-L58]", snapshot, { isLoopback: true });
    expect(html).toContain('data-line-start="42"');
    expect(html).toContain('data-line-end="58"');
  });

  it("renders a single-line span as file:line (no end suffix)", () => {
    const snapshot = buildSnapshot(["c.md"]);
    const { html } = renderPageHtml("^[c.md:42]", snapshot, { isLoopback: true });
    expect(html).toContain(">c.md:42<");
    expect(html).toContain('data-line-start="42"');
    expect(html).toContain('data-line-end="42"');
  });

  it("skips malformed entries (invalid line ranges) without breaking the chip list", () => {
    // `c.md:0-5` has a start of 0 which `extractClaimCitations` treats
    // as invalid; the chip rule should drop just that span.
    const snapshot = buildSnapshot(["c.md", "ok.md"]);
    const { html } = renderPageHtml("^[c.md:0-5, ok.md]", snapshot, { isLoopback: true });
    expect(html).toContain('data-file="ok.md"');
    expect(html).not.toContain('data-line-start="0"');
  });

  it("marks data-resolved=false when the source file is not in the snapshot", () => {
    const snapshot = buildSnapshot(["only-this.md"]);
    const { html } = renderPageHtml("^[ghost.md]", snapshot, { isLoopback: true });
    expect(html).toContain('data-resolved="false"');
  });
});

describe("citation-rule — loopback-only payloads", () => {
  it("loopback: includes data-absolute-path and data-editor-href", () => {
    const snapshot = buildSnapshot(["c.md"]);
    const { html } = renderPageHtml("^[c.md:42]", snapshot, { isLoopback: true });
    expect(html).toContain("data-absolute-path");
    expect(html).toContain("data-editor-href");
  });

  it("non-loopback: strips data-absolute-path and data-editor-href", () => {
    const snapshot = buildSnapshot(["c.md"]);
    const { html } = renderPageHtml("^[c.md:42]", snapshot, { isLoopback: false });
    expect(html).not.toContain("data-absolute-path");
    expect(html).not.toContain("data-editor-href");
  });

  it("non-bare filenames skip the editor-link payload even on loopback", () => {
    // A source filename with a separator is not "bare" — the citation
    // rule keeps the chip but refuses to construct an editor link.
    const snapshot = buildSnapshot(["nested/file.md"]);
    const { html } = renderPageHtml("^[nested/file.md:1-2]", snapshot, { isLoopback: true });
    expect(html).toContain('data-file="nested/file.md"');
    expect(html).not.toContain("data-absolute-path");
    expect(html).not.toContain("data-editor-href");
  });

  it("percent-encodes the editor-href path so filenames with spaces produce a valid URI", () => {
    // `pathToFileURL().pathname` percent-encodes URI-reserved chars
    // while preserving path separators. Visible label and
    // `data-absolute-path` remain human-readable.
    const snapshot = buildSnapshot(["my notes.md"]);
    const { html } = renderPageHtml("^[my notes.md:42]", snapshot, { isLoopback: true });
    expect(html).toMatch(/data-editor-href="vscode:\/\/file\/[^"]*my%20notes\.md:42"/);
    // Absolute-path attribute keeps the human-readable form (it's not a URI).
    expect(html).toMatch(/data-absolute-path="[^"]*my notes\.md"/);
    expect(html).toContain(">my notes.md:42<");
  });

  it("percent-encodes URI delimiters (`#`, `?`, space) so they don't become fragment/query separators", () => {
    // A filename like `notes #1?.md` is a legal Unix path but its `#`
    // and `?` are URI fragment/query delimiters. `encodeURI` preserves
    // both, which would yield a malformed editor URI; `pathToFileURL`
    // percent-encodes them. (The line-span form `^[file:42]` cannot be
    // used here because `extractClaimCitations` stops the filename at
    // `:` or `#`; the `my notes.md:42` test above covers `%20` plus
    // line-suffix preservation, this one covers the delimiter cases.)
    const snapshot = buildSnapshot(["notes #1?.md"]);
    const { html } = renderPageHtml("^[notes #1?.md]", snapshot, { isLoopback: true });
    const editorMatch = html.match(/data-editor-href="(vscode:\/\/file[^"]*)"/);
    expect(editorMatch).not.toBeNull();
    const editorHref = editorMatch![1];
    expect(editorHref).toContain("%20"); // space encoded
    expect(editorHref.toLowerCase()).toContain("%23"); // # encoded
    expect(editorHref.toLowerCase()).toContain("%3f"); // ? encoded
    expect(editorHref).not.toContain("#"); // never a raw fragment delimiter
    expect(editorHref).not.toContain("?"); // never a raw query delimiter
    // Absolute-path attribute stays human-readable.
    expect(html).toMatch(/data-absolute-path="[^"]*notes #1\?\.md"/);
  });
});
