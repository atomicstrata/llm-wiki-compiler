/**
 * Sanitizer regression matrix for `renderPageHtml`.
 *
 * One round-trip table that encodes the spec's Sanitizer Policy block:
 * every rejected protocol/attribute/tag has a "should NOT appear" case,
 * every allowed surface has a "should appear" case. The matrix is the
 * single source of truth — future policy changes are visible in a
 * single diff against this file.
 */

import { describe, it, expect } from "vitest";
import sanitizeHtml from "sanitize-html";
import { buildSanitizerPolicy, renderPageHtml } from "../src/viewer/render.js";
import type { ViewerSnapshot } from "../src/viewer/types.js";

const SNAPSHOT: ViewerSnapshot = {
  root: "/tmp/wiki",
  generatedAt: "2026-05-12T00:00:00.000Z",
  project: { title: "test-wiki", rootName: "test-wiki" },
  counts: { concepts: 0, queries: 0, sourceFiles: 0, pendingReviews: 0, compiledSources: 0 },
  index: { available: false, href: "/#/index", body: "", outgoingLinks: [] },
  recentPages: [],
  pages: [],
  sourceFilenames: [],
};

function render(markdown: string, isLoopback = true): string {
  return renderPageHtml(markdown, SNAPSHOT, { isLoopback }).html;
}

/**
 * Run dangerous HTML through the same sanitize-html policy the renderer
 * uses, bypassing markdown-it. Markdown-it has `html: false`, so most
 * raw-HTML attacks never reach the sanitizer in normal use; the
 * sanitizer is defense-in-depth and must be tested in isolation.
 */
function sanitize(rawHtml: string, isLoopback = true): string {
  return sanitizeHtml(rawHtml, buildSanitizerPolicy({ isLoopback }));
}

describe("sanitizer — rejected surfaces", () => {
  it("drops <script> tags entirely (defense-in-depth on the sanitizer)", () => {
    // The renderer escapes raw HTML to text via markdown-it's `html:false`,
    // so a <script> tag never reaches the sanitizer in normal use. This
    // checks the sanitizer's behavior directly as a defense-in-depth gate.
    const sanitized = sanitize('Body. <script>alert("xss")</script> More body.');
    expect(sanitized).not.toMatch(/<script/i);
    expect(sanitized).not.toMatch(/alert\s*\(/i);
  });

  it("strips javascript: hrefs", () => {
    const html = render("[click](javascript:alert(1))");
    expect(html).not.toMatch(/href=["']?javascript:/i);
  });

  it("strips vbscript: hrefs", () => {
    const html = render("[click](vbscript:msgbox(1))");
    expect(html).not.toMatch(/href=["']?vbscript:/i);
  });

  it("strips arbitrary data: hrefs from anchors", () => {
    const html = render("[click](data:text/html,<svg/onload=alert(1)>)");
    expect(html).not.toMatch(/href=["']?data:/i);
  });

  it("rejects data: img src that is not image/", () => {
    const html = render("![alt](data:text/html,<svg/onload=alert(1)>)");
    expect(html).not.toMatch(/src=["']?data:text/i);
  });

  it("allows data:image/* img src", () => {
    const html = render("![alt](data:image/png;base64,iVBORw0KGgo)");
    expect(html).toMatch(/src=["']?data:image\/png/);
  });

  it("strips protocol-relative URLs", () => {
    const html = render("[click](//evil.example.com/path)");
    expect(html).not.toMatch(/href=["']?\/\/evil/);
  });

  it("strips inline style attributes", () => {
    // Tested against the sanitizer directly: markdown-it has html:false
    // so a raw `<p style="...">` is escaped to text and never reaches the
    // sanitizer. If a future change ever admits raw HTML, the sanitizer
    // is the last line of defence.
    const sanitized = sanitize('<p style="color:red">x</p>');
    expect(sanitized).not.toMatch(/style\s*=/i);
  });

  it("strips event-handler attributes like onclick", () => {
    const sanitized = sanitize('<a href="#" onclick="alert(1)">x</a>');
    expect(sanitized).not.toMatch(/onclick/i);
  });

  it("strips srcdoc on iframes (which are also banned outright)", () => {
    const sanitized = sanitize('<iframe srcdoc="<script>alert(1)</script>"></iframe>');
    expect(sanitized).not.toMatch(/<iframe/i);
    expect(sanitized).not.toMatch(/srcdoc/i);
  });

  it("rejects unknown tags like <custom-thing>", () => {
    const sanitized = sanitize("<custom-thing>x</custom-thing>");
    expect(sanitized).not.toMatch(/<custom-thing/i);
  });

  it("omits vscode: hrefs on non-loopback binds", () => {
    const html = render("[edit](vscode://file/Users/anyone/x.md:42)", false);
    expect(html).not.toMatch(/href=["']?vscode:/i);
  });
});

describe("sanitizer — allowed surfaces", () => {
  it("allows http and https links", () => {
    const html = render("[a](https://example.com) [b](http://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="http://example.com"');
  });

  it("allows mailto links", () => {
    const html = render("[mail](mailto:user@example.com)");
    expect(html).toContain('href="mailto:user@example.com"');
  });

  it("allows hash-only links (the viewer's hash router relies on these)", () => {
    const html = render("[home](#/) [page](#/concepts/foo) [anchor](#section-2)");
    expect(html).toContain('href="#/"');
    expect(html).toContain('href="#/concepts/foo"');
    expect(html).toContain('href="#section-2"');
  });

  it("strips ALL vscode:// anchor hrefs even on loopback (editor links live on chip spans, not anchors)", () => {
    // After the review pass the anchor allowlist no longer permits
    // `vscode://`. Citation chips expose `vscode://file/...` only via
    // a `<span data-editor-href>` (a data attribute, not an `<a href>`),
    // so this gate blocks markdown-authored anchors regardless of
    // whether they look like an editor link or a command URI.
    expect(render("[edit](vscode://file/tmp/x.md:42)")).not.toMatch(/href=["']?vscode:/i);
    expect(render("[evil](vscode://evil/command/some.thing)")).not.toMatch(/href=["']?vscode:/i);
    expect(render("[a](vscode://file//Users/anyone/.ssh/id_rsa)")).not.toMatch(/href=["']?vscode:/i);
  });
});

describe("sanitizer — LAN-mode defense-in-depth", () => {
  it("strips `data-absolute-path` and `data-editor-href` from spans on non-loopback binds", () => {
    const raw = '<span class="citation-chip" data-absolute-path="/tmp/x.md" data-editor-href="vscode://file//tmp/x.md:1">label</span>';
    const sanitized = sanitize(raw, false);
    expect(sanitized).not.toMatch(/data-absolute-path/i);
    expect(sanitized).not.toMatch(/data-editor-href/i);
    // The span itself + its class/label survive — only the LAN-sensitive attributes are stripped.
    expect(sanitized).toMatch(/<span[^>]*class="citation-chip"[^>]*>label<\/span>/);
  });

  it("keeps `data-absolute-path` and `data-editor-href` on spans when bound to loopback", () => {
    const raw = '<span class="citation-chip" data-absolute-path="/tmp/x.md" data-editor-href="vscode://file//tmp/x.md:1">label</span>';
    const sanitized = sanitize(raw, true);
    expect(sanitized).toMatch(/data-absolute-path="\/tmp\/x\.md"/);
    expect(sanitized).toMatch(/data-editor-href="vscode:\/\/file\/\/tmp\/x\.md:1"/);
  });
});
