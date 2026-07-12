/**
 * @file test/profile-template-signing-continuity.test.ts
 * @description Publisher pin, rotation, revocation, rollback, and immutable-coordinate tests.
 */
import { describe, expect, it } from "vitest";
import { advancePublisherPins, assertPackageNotRevoked, emptyPublisherPinState } from "../src/profile/templates/signing/continuity.js";
import { verifyTapIndex } from "../src/profile/templates/signing/verify.js";
import type { SignedTapIndex } from "../src/profile/templates/signing/types.js";
import { PUBLISHER_KEY_2, TAP_KEY, signedIndex, signedRotation } from "./fixtures/template-signing.js";

describe("publisher continuity", () => {
  it("pins a first-seen publisher and coordinate", () => {
    const state = advancePublisherPins(verified(), emptyPublisherPinState("official"));
    expect(state.publishers.atomicstrata.keyId).toBe("publisher-key-1");
    expect(state.highestSequence).toBe(1);
  });

  it("refuses sequence replay and immutable-coordinate remapping", () => {
    const state = advancePublisherPins(verified(), emptyPublisherPinState("official"));
    expect(() => advancePublisherPins(verified(), state)).toThrow(/rollback or replay/);
    const remapped = signedIndex({ sequence: 2, packages: [{ ...signedIndex().packages[0], payloadDigest: `sha256:${"a".repeat(64)}` }] });
    expect(() => advancePublisherPins(verified(remapped), state)).toThrow(/coordinate remapped/);
  });

  it("refuses bare publisher replacement", () => {
    const state = advancePublisherPins(verified(), emptyPublisherPinState("official"));
    const replacement = signedIndex({ sequence: 2, publishers: { atomicstrata: PUBLISHER_KEY_2 } });
    expect(() => advancePublisherPins(verified(replacement), state)).toThrow(/without a valid rotation/);
  });

  it("accepts a dual-signed publisher rotation", () => {
    const state = advancePublisherPins(verified(), emptyPublisherPinState("official"));
    const rotated = signedIndex({
      sequence: 2,
      publishers: { atomicstrata: PUBLISHER_KEY_2 },
      rotations: [signedRotation(2)],
    });
    expect(advancePublisherPins(verified(rotated), state).publishers.atomicstrata).toEqual(PUBLISHER_KEY_2);
  });

  it("accumulates revocations and refuses revoked evidence", () => {
    const digest = signedIndex().packages[0].payloadDigest;
    const index = signedIndex({ revocations: [{ kind: "package", value: digest, reason: "compromised", revokedAt: "2026-07-12T01:00:00Z" }] });
    const state = advancePublisherPins(verified(index), emptyPublisherPinState("official"));
    expect(() => assertPackageNotRevoked(state, digest, "publisher-key-1")).toThrow(/package digest is revoked/);
  });

  it("refuses crossing tap trust domains", () => {
    expect(() => advancePublisherPins(verified(), emptyPublisherPinState("community"))).toThrow(/another tap/);
  });
});

function verified(index: SignedTapIndex = signedIndex()) {
  return verifyTapIndex(index, "official", TAP_KEY, new Date("2026-07-13T00:00:00Z"));
}
