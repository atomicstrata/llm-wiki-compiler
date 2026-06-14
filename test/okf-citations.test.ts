import { describe, it, expect } from "vitest";
import { canonicalBody, safeRefName } from "../src/export/okf/mapping.js";
import { renderCitationsSection } from "../src/export/okf/citations.js";

/** A refName lookup that maps every file to its safe name (everything bundled). */
const allRefs = (file: string): string | null => safeRefName(file);

describe("canonical body + derived citations", () => {
  it("canonicalBody strips a trailing derived # Citations section", () => {
    const withCites = "Para ^[a.md].\n\n# Citations\n\n1. [a.md](/references/a.md)\n";
    expect(canonicalBody(withCites)).toBe("Para ^[a.md].\n");
    expect(canonicalBody("Para ^[a.md].\n")).toBe("Para ^[a.md].\n");
  });
  it("renderCitationsSection builds bundle-relative reference links (safe names) when bundled", () => {
    const s = renderCitationsSection([{ file: "a.md", start: 1, end: 3 }, { file: "b.md" }], allRefs);
    expect(s).toContain("# Citations");
    expect(s).toContain(`[a.md:1-3](/references/${safeRefName("a.md")})`);
    expect(s).toContain(`[b.md](/references/${safeRefName("b.md")})`);
  });
  it("renderCitationsSection emits plain text (no link) when the file was not bundled", () => {
    const s = renderCitationsSection([{ file: "missing.md", start: 1, end: 3 }], () => null);
    expect(s).toContain("# Citations");
    expect(s).toContain("1. missing.md:1-3");
    expect(s).not.toContain("/references/");
  });
  it("renderCitationsSection is empty for no citations", () => {
    expect(renderCitationsSection([], allRefs)).toBe("");
  });
  it("safeRefName strips traversal and flattens nested paths, ending in original extension", () => {
    expect(safeRefName("../secret.md")).toMatch(/^secret-[0-9a-f]{8}\.md$/);
    expect(safeRefName("nested/a.md")).toMatch(/^nested__a-[0-9a-f]{8}\.md$/);
  });
  it("safeRefName is injective for names that collided under the old flat scheme", () => {
    expect(safeRefName("a/b.md")).not.toBe(safeRefName("a__b.md"));
    expect(safeRefName("a b.md")).not.toBe(safeRefName("a_b.md"));
    expect(safeRefName("a/b.md")).toMatch(/\.md$/);
    expect(safeRefName("a__b.md")).toMatch(/\.md$/);
  });
});
