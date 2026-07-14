/**
 * @file test/profile-template-signing-canonical-base64.test.ts
 * @description Regression coverage for byte-equivalent, non-canonical Base64
 * aliases at the shared signed-template protocol boundary.
 */
import { describe, expect, it } from "vitest";
import {
  parseSignedPackage,
  parseSignedTapIndex,
} from "../src/profile/templates/signing/protocol.js";
import { signedIndex, signedPackage } from "./fixtures/template-signing.js";

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

describe("signed template canonical Base64 parsing", () => {
  it("rejects a byte-equivalent alias of an index signature", () => {
    const index = signedIndex();
    index.signature.value = nonCanonicalAlias(index.signature.value);

    expect(() => parseSignedTapIndex(JSON.stringify(index))).toThrow(/canonical base64/);
  });

  it("rejects a byte-equivalent alias of a package signature", () => {
    const envelope = signedPackage();
    envelope.publisherSignature.value = nonCanonicalAlias(
      envelope.publisherSignature.value,
    );

    expect(() => parseSignedPackage(JSON.stringify(envelope))).toThrow(/canonical base64/);
  });
});

function nonCanonicalAlias(canonical: string): string {
  const paddingIndex = canonical.indexOf("=");
  const finalDataIndex = paddingIndex - 1;
  const canonicalValue = BASE64_ALPHABET.indexOf(canonical[finalDataIndex]);
  const aliasValue = canonicalValue ^ 1;
  const alias = `${canonical.slice(0, finalDataIndex)}${BASE64_ALPHABET[aliasValue]}${canonical.slice(finalDataIndex + 1)}`;

  expect(Buffer.from(alias, "base64")).toEqual(Buffer.from(canonical, "base64"));
  expect(alias).not.toBe(canonical);
  return alias;
}
