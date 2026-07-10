/**
 * @file test/connectors/crossref.test.ts
 * @description Crossref connector normalization from offline fixture JSON.
 */
import { describe, expect, it } from "vitest";
import fixture from "../fixtures/crossref-work.json" with { type: "json" };
import { crossrefConnector } from "../../src/connectors/impl/crossref.js";

describe("crossref connector", () => {
  it("builds an escaped DOI works URL", () => {
    const req = crossrefConnector.buildRequest({ doi: "10.123/ABC DEF" });
    expect(req.url).toBe("https://api.crossref.org/works/10.123%2FABC%20DEF");
  });

  it("normalizes one work into a paper draft with typed fields", () => {
    const drafts = crossrefConnector.parse(JSON.stringify(fixture), { doi: "10.123/example" });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.fields.title).toContain("Example Paper");
    expect(drafts[0]?.fields.doi).toBe("10.123/example");
    expect(drafts[0]?.fields.year).toBe(2024);
    expect(drafts[0]?.fields.authors).toEqual(["Ada Lovelace"]);
    expect(drafts[0]?.fields.stage).toBe("imported");
    expect(drafts[0]?.content).toContain("Example abstract");
  });

  it("canonicalizes DOI source ids", () => {
    expect(crossrefConnector.canonicalSourceId({ doi: "https://doi.org/10.123/ABC" })).toBe("10.123/abc");
  });
});
