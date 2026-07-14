/**
 * @file test/template-publish-sign.test.ts
 * @description Producer signing primitives must verify under the PRODUCTION verifier.
 * The index claim is the load-bearing case: `verifyTapIndex` previously derived the
 * signed bytes inline, so a builder that re-derived that shape would be a second
 * implementation of the signed bytes — the divergence that yields signed-but-
 * unverifiable releases. These tests pin producer and consumer to one definition.
 */
import { describe, expect, it } from "vitest";
import { canonicalBytes, packageClaim, tapIndexClaim } from "../src/profile/templates/signing/canonical.js";
import { generateEd25519Keypair, signClaim } from "../src/profile/templates/signing/sign.js";
import { parseSignedTapIndex } from "../src/profile/templates/signing/protocol.js";
import { verifyTapIndex } from "../src/profile/templates/signing/verify.js";
import type { SignedTapIndex } from "../src/profile/templates/signing/types.js";

function unsignedIndex(publicKey: string): Omit<SignedTapIndex, "signature"> {
  return {
    schemaVersion: 1,
    tap: "community",
    sequence: 1,
    generatedAt: "2026-07-14T00:00:00.000Z",
    expiresAt: "2126-07-14T00:00:00.000Z",
    publishers: { acme: { keyId: "acme-1", publicKey } },
    packages: [],
    rotations: [],
    revocations: [],
  };
}

describe("publisher signing primitives", () => {
  it("produces an index signature the production verifier accepts", () => {
    const tap = generateEd25519Keypair("community-tap-1");
    const unsigned = unsignedIndex(tap.publicKey.publicKey);
    const signature = signClaim(tapIndexClaim(unsigned), tap.privateKey);

    const parsed = parseSignedTapIndex(JSON.stringify({ ...unsigned, signature }));

    expect(() => verifyTapIndex(parsed, "community", tap.publicKey)).not.toThrow();
  });

  it("signs the canonical claim bytes, not the object", () => {
    const key = generateEd25519Keypair("acme-1");
    const claim = packageClaim("community/acme/x@1.0.0", `sha256:${"a".repeat(64)}`);
    const signature = signClaim(claim, key.privateKey);

    expect(signature).toMatchObject({ keyId: "acme-1", algorithm: "ed25519" });
    expect(Buffer.from(signature.value, "base64")).toHaveLength(64);
    expect(canonicalBytes(claim).toString("utf8"))
      .toBe(`{"coordinate":"community/acme/x@1.0.0","payloadDigest":"sha256:${"a".repeat(64)}"}`);
  });

  it("refuses a signature made over a mutated claim", () => {
    const tap = generateEd25519Keypair("community-tap-1");
    const unsigned = unsignedIndex(tap.publicKey.publicKey);
    const signature = signClaim(tapIndexClaim(unsigned), tap.privateKey);

    const parsed = parseSignedTapIndex(JSON.stringify({ ...unsigned, sequence: 2, signature }));

    expect(() => verifyTapIndex(parsed, "community", tap.publicKey))
      .toThrow(/signature verification failed/i);
  });

  it("refuses a private key that is not Ed25519", () => {
    expect(() => signClaim({ a: 1 }, { keyId: "x", privateKey: "bm90LWEta2V5" }))
      .toThrow();
  });
});
