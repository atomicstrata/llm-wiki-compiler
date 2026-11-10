/**
 * Pure helpers of the v2 viewer client: hash routing, which must agree with the
 * links the server renders, and finding a source's images in its text.
 */
import { describe, expect, it } from "vitest";
import { citationHref, pageHref, pageIdHref, parseRoute, searchHref, sourceHref } from "../viewer-v2/src/route.js";
import { sourceImageNames } from "../viewer-v2/src/source-images.js";

describe("v2 viewer routes", () => {
  it("round-trips a page whose slug needs encoding", () => {
    expect(parseRoute(pageHref("concepts", "júlias farewell"))).toEqual({
      view: "page", directory: "concepts", slug: "júlias farewell",
    });
    expect(pageIdHref("concepts/kiln-notes")).toBe("#/concepts/kiln-notes");
  });

  it("round-trips a source with a cited line range", () => {
    expect(parseRoute(sourceHref("notes.md", 12, 15))).toEqual({
      view: "source", id: "notes.md", lineStart: 12, lineEnd: 15,
    });
    expect(parseRoute(sourceHref("notes.md", 7))).toMatchObject({ lineStart: 7, lineEnd: 7 });
    expect(parseRoute(sourceHref("notes.md"))).toEqual({ view: "source", id: "notes.md" });
  });

  it("round-trips a search and ignores a reversed line range", () => {
    expect(parseRoute(searchHref("cone 6 & glaze"))).toEqual({ view: "search", query: "cone 6 & glaze" });
    expect(parseRoute("#/sources/notes.md?lines=9-3")).toEqual({ view: "source", id: "notes.md" });
  });

  it("links a citation chip to its source lines, and nowhere without a file", () => {
    expect(citationHref("notes.md", "12", "15")).toBe("#/sources/notes.md?lines=12-15");
    expect(citationHref("notes.md", "12")).toBe("#/sources/notes.md?lines=12-12");
    expect(citationHref("notes.md")).toBe("#/sources/notes.md");
    expect(citationHref(undefined, "12")).toBeNull();
  });

  it.each(["", "#", "#/", "#/concepts", "#/a/b/c", "#/concepts/%E0%A4%A"])("treats %j as home", (hash) => {
    expect(parseRoute(hash)).toEqual({ view: "home" });
  });
});

describe("v2 viewer source images", () => {
  it("reads an inline frontmatter list and Markdown embeds without duplicates", () => {
    const text = '---\nimages: ["a1.png", "b-2.JPG"]\ntitle: x\n---\n\n![shot](images/a1.png)\n![other](images/c.webp)\n';
    expect(sourceImageNames(text)).toEqual(["a1.png", "b-2.JPG", "c.webp"]);
  });

  it("reads a block frontmatter list and stops at the next key", () => {
    const text = "---\nimages:\n  - one.png\n  - two.gif\nnote: later.png\n---\nbody\n";
    expect(sourceImageNames(text)).toEqual(["one.png", "two.gif"]);
  });

  it("ignores remote images, other folders and non-image files", () => {
    const text = "![a](https://example.com/x.png)\n![b](other/y.png)\n![c](images/notes.md)\n";
    expect(sourceImageNames(text)).toEqual([]);
  });
});
