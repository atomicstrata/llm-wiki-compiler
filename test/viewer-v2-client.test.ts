/**
 * Hash routing of the v2 viewer client, which must agree with the links the
 * server renders.
 */
import { describe, expect, it } from "bun:test";
import { journeyHref, lineRange, pageHref, pageIdHref, parseRoute, searchHref, sourceHref, typeListHref } from "../viewer-v2/src/route.js";

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

  it("reads a cited line range the same way for chips and source links", () => {
    expect(lineRange("12", "15")).toEqual({ lineStart: 12, lineEnd: 15 });
    expect(lineRange("12", undefined)).toEqual({ lineStart: 12, lineEnd: 12 });
    expect(lineRange("9", "3")).toEqual({});
    expect(lineRange(undefined, "3")).toEqual({});
  });

  it("names the original client's screens by the same hashes", () => {
    expect(parseRoute("#/concepts")).toEqual({ view: "list", kind: "concepts" });
    expect(parseRoute("#/source-changes")).toEqual({ view: "sourceChanges" });
    expect(parseRoute("#/recent")).toEqual({ view: "recent" });
    expect(parseRoute(typeListHref("papers"))).toEqual({ view: "typeList", type: "papers" });
    expect(parseRoute("#/papers")).toEqual({ view: "home" });
  });

  it("round-trips a run's journey, with both ids encoded", () => {
    expect(parseRoute(journeyHref("review flow", "run/1"))).toEqual({ view: "journey", workflowId: "review flow", runId: "run/1" });
    expect(journeyHref("review flow", "run/1")).toBe("#/_journey/review%20flow/run%2F1");
  });

  it.each(["", "#", "#/", "#/nonsense", "#/a/b/c", "#/_journey/wf", "#/_journey/wf/run/extra", "#/concepts/%E0%A4%A"])("treats %j as home", (hash) => {
    expect(parseRoute(hash)).toEqual({ view: "home" });
  });
});
