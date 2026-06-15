import { describe, it, expect } from "vitest";
import { okfLinksToWikilinks } from "../src/export/okf/mapping.js";

// resolveLink: linkPath -> { slug, title } | null for known bundle docs.
const resolveLink = (p: string) =>
  p === "tables/customers" ? { slug: "tables-customers", title: "Customers" }
  : p === "concepts/rag" ? { slug: "rag", title: "RAG" }
  : null;

describe("okfLinksToWikilinks (generalized)", () => {
  it("reverses a nested foreign path to a wikilink when known", () => {
    expect(okfLinksToWikilinks("See [Customers](/tables/customers.md).", resolveLink)).toBe("See [[tables-customers]].");
  });
  it("still reverses concepts/queries paths (backward compatible)", () => {
    expect(okfLinksToWikilinks("[RAG](/concepts/rag.md)", resolveLink)).toBe("[[rag]]");
    expect(okfLinksToWikilinks("[Retrieval](/concepts/rag.md)", resolveLink)).toBe("[[rag|Retrieval]]");
  });
  it("leaves an unknown/external path verbatim (no over-match)", () => {
    expect(okfLinksToWikilinks("[x](/external/thing.md)", resolveLink)).toBe("[x](/external/thing.md)");
  });
});
