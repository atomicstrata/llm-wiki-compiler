/**
 * @file test/profile-template-signing-protocol.test.ts
 * @description Adversarial parser and canonicalization tests for signed templates.
 */
import { describe, expect, it } from "vitest";
import { canonicalBytes } from "../src/profile/templates/signing/canonical.js";
import { parseBoundedUniqueJson } from "../src/profile/templates/signing/json.js";
import { parseSignedPackage, parseSignedTapIndex, parseTemplateCoordinate } from "../src/profile/templates/signing/protocol.js";
import { signedIndex, signedPackage } from "./fixtures/template-signing.js";

describe("signed template protocol parsing", () => {
  it("canonicalizes reordered object keys to identical bytes", () => {
    expect(canonicalBytes({ b: 2, a: 1 })).toEqual(canonicalBytes({ a: 1, b: 2 }));
  });

  it("rejects duplicate keys before native JSON parsing collapses them", () => {
    expect(() => parseBoundedUniqueJson('{"tap":"official","tap":"evil"}', 1024)).toThrow(/duplicate JSON key/);
  });

  it("rejects excessive nesting and oversized JSON", () => {
    expect(() => parseBoundedUniqueJson("[[[[0]]]]", 1024, 2)).toThrow(/depth cap/);
    expect(() => parseBoundedUniqueJson(JSON.stringify({ x: "a".repeat(100) }), 10)).toThrow(/byte cap/);
  });

  it("parses exact package and index records", () => {
    expect(parseSignedPackage(JSON.stringify(signedPackage())).coordinate).toContain("@1.0.0");
    expect(parseSignedTapIndex(JSON.stringify(signedIndex())).tap).toBe("official");
  });

  it("rejects unknown fields and duplicate coordinates", () => {
    expect(() => parseSignedPackage(JSON.stringify({ ...signedPackage(), authority: true }))).toThrow(/unsupported/);
    const index = signedIndex();
    index.packages.push(index.packages[0]);
    expect(() => parseSignedTapIndex(JSON.stringify(index))).toThrow(/duplicate package coordinate/);
  });

  it("requires fully qualified, unambiguous coordinates", () => {
    expect(parseTemplateCoordinate("official/atomicstrata/team@1.2.3")).toMatchObject({ templateId: "team", version: "1.2.3" });
    expect(() => parseTemplateCoordinate("team@1.2.3")).toThrow(/invalid template coordinate/);
    expect(() => parseTemplateCoordinate("official/atomicstrata/team/extra@1.2.3")).toThrow(/invalid template coordinate/);
  });
});
