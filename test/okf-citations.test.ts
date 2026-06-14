import { describe, it, expect } from "vitest";
import { canonicalBody } from "../src/export/okf/mapping.js";
import { renderCitationsSection } from "../src/export/okf/citations.js";

describe("canonical body + derived citations", () => {
  it("canonicalBody strips a trailing derived # Citations section", () => {
    const withCites = "Para ^[a.md].\n\n# Citations\n\n1. [a.md](/references/a.md)\n";
    expect(canonicalBody(withCites)).toBe("Para ^[a.md].\n");
    expect(canonicalBody("Para ^[a.md].\n")).toBe("Para ^[a.md].\n");
  });
  it("renderCitationsSection builds bundle-relative reference links (safe names)", () => {
    const s = renderCitationsSection([{ file: "a.md", start: 1, end: 3 }, { file: "b.md" }]);
    expect(s).toContain("# Citations");
    expect(s).toContain("[a.md:1-3](/references/a.md)");
    expect(s).toContain("[b.md](/references/b.md)");
  });
  it("renderCitationsSection is empty for no citations", () => {
    expect(renderCitationsSection([])).toBe("");
  });
});
