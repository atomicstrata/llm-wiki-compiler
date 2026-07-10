import { describe, it, expect } from "vitest";
import { qualifiedPageId, parseQualifiedPageId, pageDirectoryFromPageId, slugFromPageId, isReservedNamespace } from "../src/utils/page-id.js";

describe("page-id grammar", () => {
  it("builds + round-trips", () => {
    expect(qualifiedPageId("concepts", "foo")).toBe("concepts/foo");
    expect(parseQualifiedPageId("papers/deep-nets")).toEqual({ namespace: "papers", pagePart: "deep-nets" });
  });
  it("splits on the FIRST slash; a 2nd slash is invalid (page-part has no '/')", () => {
    expect(parseQualifiedPageId("concepts/a/b")).toBeNull();
  });
  it("allows raw default stems: spaces, Unicode, '#'", () => {
    expect(parseQualifiedPageId("concepts/Foo Bar")).toEqual({ namespace: "concepts", pagePart: "Foo Bar" });
    expect(parseQualifiedPageId("concepts/研究")).toEqual({ namespace: "concepts", pagePart: "研究" });
    expect(parseQualifiedPageId("concepts/Foo #1")).toEqual({ namespace: "concepts", pagePart: "Foo #1" });
  });
  it("rejects path-dangerous page-parts anywhere: backslash, colon, NUL, '.', '..', empty", () => {
    for (const bad of ["concepts/..", "concepts/.", "concepts/", "concepts/a\\b", "concepts/C:secret", "concepts/a\0b", "concepts/a/../b"]) {
      expect(parseQualifiedPageId(bad)).toBeNull();
    }
  });
  it("rejects a non-slug-safe namespace", () => {
    expect(parseQualifiedPageId("Concepts/foo")).toBeNull();
    expect(parseQualifiedPageId("a b/foo")).toBeNull();
    expect(parseQualifiedPageId("noSlash")).toBeNull();
  });
  it("accessors + reserved check", () => {
    expect(pageDirectoryFromPageId("queries/x")).toBe("queries");
    expect(slugFromPageId("papers/x")).toBe("x");
    expect(isReservedNamespace("concepts")).toBe(true);
    expect(isReservedNamespace("queries")).toBe(true);
    expect(isReservedNamespace("papers")).toBe(false);
  });
});
