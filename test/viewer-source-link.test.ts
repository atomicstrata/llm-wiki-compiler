/**
 * Links from a page to its ingested sources.
 *
 * The compiler writes a page's `## Sources` list as Markdown links to the bare
 * source filename. The renderer must turn exactly those into the viewer's source
 * route, and must keep dropping every other relative link.
 */
import { describe, expect, it } from "vitest";
import { renderPageHtml } from "../src/viewer/render.js";
import type { ViewerSnapshot } from "../src/viewer/types.js";

/** Render Markdown against a snapshot that knows the given source files. */
function render(markdown: string, sourceFilenames: string[]): string {
  const snapshot = { root: "/tmp/wiki", pages: [], sourceFilenames } as unknown as ViewerSnapshot;
  return renderPageHtml(markdown, snapshot, { isLoopback: true }).html;
}

describe("source links in rendered pages", () => {
  it("points a link to a known source file at the source route", () => {
    const html = render("## Sources\n\n- [Kiln log](kiln-log.md)\n", ["kiln-log.md"]);
    expect(html).toContain('<a href="#/_source/kiln-log.md">Kiln log</a>');
  });

  it("encodes a filename that needs it", () => {
    const html = render("[Notes](<kiln log.md>)", ["kiln log.md"]);
    expect(html).toContain('href="#/_source/kiln%20log.md"');
  });

  it.each([
    ["a file that is not a source", "[Other](other.md)"],
    ["a path into another directory", "[Up](../kiln-log.md)"],
    ["a source name with a fragment", "[Part](kiln-log.md#L3)"],
  ])("leaves %s without an href", (_label, markdown) => {
    expect(render(markdown, ["kiln-log.md"])).not.toContain("href=");
  });

  it("does not touch absolute links", () => {
    expect(render("[Site](https://example.com/kiln-log.md)", ["kiln-log.md"]))
      .toContain('href="https://example.com/kiln-log.md"');
  });
});
