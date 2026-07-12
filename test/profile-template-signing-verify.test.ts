/**
 * @file test/profile-template-signing-verify.test.ts
 * @description Native Ed25519 tap and publisher verification regressions.
 */
import { describe, expect, it } from "vitest";
import { advancePublisherPins, emptyPublisherPinState } from "../src/profile/templates/signing/continuity.js";
import { verifySignedPackage, verifyTapIndex, verifyTapKeyRotation } from "../src/profile/templates/signing/verify.js";
import { COORDINATE, TAP_KEY, TAP_KEY_2, parsedIndex, parsedPackage, signedIndex, signedTapRotation } from "./fixtures/template-signing.js";

describe("signed template verification", () => {
  it("accepts a valid tap index and package envelope", () => {
    const index = verifyTapIndex(parsedIndex(), "official", TAP_KEY, new Date("2026-07-13T00:00:00Z"));
    expect(verifySignedPackage(parsedPackage(), index, accepted(index), "1.0.0").templateId).toBe("team");
  });

  it("refuses tampered tap metadata and wrong tap identity", () => {
    const tampered = parsedIndex();
    tampered.sequence = 2;
    expect(() => verifyTapIndex(tampered, "official", TAP_KEY, new Date("2026-07-13T00:00:00Z"))).toThrow(/signature/);
    expect(() => verifyTapIndex(parsedIndex(), "community", TAP_KEY, new Date("2026-07-13T00:00:00Z"))).toThrow(/expected tap/);
  });

  it("refuses expired indexes", () => {
    expect(() => verifyTapIndex(parsedIndex(), "official", TAP_KEY, new Date("2028-01-01T00:00:00Z"))).toThrow(/expired/);
  });

  it("refuses an index generated beyond the clock-skew allowance", () => {
    const future = parsedIndex({ generatedAt: "2027-01-01T00:00:00Z" });
    expect(() => verifyTapIndex(future, "official", TAP_KEY, new Date("2026-07-13T00:00:00Z"))).toThrow(/future/);
  });

  it("refuses payload substitution even when the stored digest is unchanged", () => {
    const envelope = parsedPackage();
    envelope.payload = { ...envelope.payload, displayName: "Attacker" };
    const index = verifiedIndex();
    expect(() => verifySignedPackage(envelope, index, accepted(index), "1.0.0")).toThrow(/digest/);
  });

  it("refuses coordinate and payload identity confusion", () => {
    const envelope = parsedPackage();
    envelope.coordinate = COORDINATE.replace("team", "other");
    const verified = verifiedIndex();
    expect(() => verifySignedPackage(envelope, verified, accepted(verified), "1.0.0")).toThrow(/coordinate/);
    const wrongIdentity = parsedPackage({ ...envelope.payload, publisher: "attacker" });
    const index = parsedIndex({ packages: [{ ...signedIndex().packages[0], payloadDigest: wrongIdentity.payloadDigest }] });
    const verifiedWrongIdentity = verifyTapIndex(index, "official", TAP_KEY, new Date("2026-07-13T00:00:00Z"));
    expect(() => verifySignedPackage(wrongIdentity, verifiedWrongIdentity, accepted(verifiedWrongIdentity), "1.0.0"))
      .toThrow(/identity/);
  });

  it("accepts only a dual-signed tap-root rotation", () => {
    expect(verifyTapKeyRotation("official", signedTapRotation(), TAP_KEY)).toEqual(TAP_KEY_2);
    const broken = signedTapRotation();
    broken.newSignature.value = broken.oldSignature.value;
    expect(() => verifyTapKeyRotation("official", broken, TAP_KEY)).toThrow(/signature/);
  });

  it("refuses a signed package after its digest is revoked", () => {
    const digest = parsedPackage().payloadDigest;
    const raw = parsedIndex({ revocations: [{ kind: "package", value: digest, reason: "withdrawn", revokedAt: "2026-07-12T01:00:00Z" }] });
    const index = verifyTapIndex(raw, "official", TAP_KEY, new Date("2026-07-13T00:00:00Z"));
    expect(() => verifySignedPackage(parsedPackage(), index, accepted(index), "1.0.0")).toThrow(/revoked/);
  });
});

function verifiedIndex() {
  return verifyTapIndex(parsedIndex(), "official", TAP_KEY, new Date("2026-07-13T00:00:00Z"));
}

function accepted(index: ReturnType<typeof verifiedIndex>) {
  return advancePublisherPins(index, emptyPublisherPinState("official"));
}
