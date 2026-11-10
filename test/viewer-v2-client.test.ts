/**
 * Hash routing of the v2 viewer client, which must agree with the links the
 * server renders.
 */
import { describe, expect, it } from "vitest";
import { citationHref, pageHref, pageIdHref, parseRoute, searchHref, sourceHref } from "../viewer-v2/src/route.js";

describe("v2 viewer routes", () => {
  it("round-trips a page whose slug needs encoding", () => {
    expect(parseRoute(pageHref("concepts", "júlias farewell"))).toEqual({
      view: "page", directory: "concepts", slug: "júlias farewell",
    });
    expect(pageIdHref("concepts/kiln-notes")).toBe("#/concepts/kiln-notes");
  });

  it("opens the source link the server renders for a page's Sources list", () => {
    expect(parseRoute("#/_source/kiln%20log.md")).toEqual({ view: "source", id: "kiln log.md" });
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
    expect(parseRoute("#/_source/notes.md?start=9&end=3")).toEqual({ view: "source", id: "notes.md" });
    expect(parseRoute("#/_source/notes.md?start=x")).toEqual({ view: "source", id: "notes.md" });
  });

  it("links a citation chip to its source lines, and nowhere without a file", () => {
    expect(citationHref("notes.md", "12", "15")).toBe("#/_source/notes.md?start=12&end=15");
    expect(citationHref("notes.md", "12")).toBe("#/_source/notes.md?start=12&end=12");
    expect(citationHref("notes.md")).toBe("#/_source/notes.md");
    expect(citationHref(undefined, "12")).toBeNull();
  });

  it.each(["", "#", "#/", "#/concepts", "#/a/b/c", "#/concepts/%E0%A4%A"])("treats %j as home", (hash) => {
    expect(parseRoute(hash)).toEqual({ view: "home" });
  });
});
