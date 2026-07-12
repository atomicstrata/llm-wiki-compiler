/**
 * @file test/profile-template-signing-continuity.test.ts
 * @description Publisher pin, rotation, revocation, rollback, and immutable-coordinate tests.
 */
import { describe, expect, it } from "vitest";
import { advancePublisherPins, assertPackageNotRevoked, emptyPublisherPinState } from "../src/profile/templates/signing/continuity.js";
import { verifyTapIndex } from "../src/profile/templates/signing/verify.js";
import type { ParsedTapIndex } from "../src/profile/templates/signing/protocol.js";
import { PUBLISHER_KEY_2, PUBLISHER_KEY_3, TAP_KEY, parsedIndex, signedIndex, signedRotation, signedSecondRotation } from "./fixtures/template-signing.js";

describe("publisher continuity", () => {
  it("pins a first-seen publisher and coordinate", () => {
    const state = advancePublisherPins(verified(), emptyPublisherPinState("official"));
    expect(state.publishers.atomicstrata.keyId).toBe("publisher-key-1");
    expect(state.highestSequence).toBe(1);
  });

  it("refuses sequence replay and immutable-coordinate remapping", () => {
    const state = advancePublisherPins(verified(), emptyPublisherPinState("official"));
    expect(() => advancePublisherPins(verified(), state)).toThrow(/rollback or replay/);
    const remapped = parsedIndex({ sequence: 2, packages: [{ ...signedIndex().packages[0], payloadDigest: `sha256:${"a".repeat(64)}` }] });
    expect(() => advancePublisherPins(verified(remapped), state)).toThrow(/coordinate remapped/);
  });

  it("refuses bare publisher replacement", () => {
    const state = advancePublisherPins(verified(), emptyPublisherPinState("official"));
    const replacement = parsedIndex({ sequence: 2, publishers: { atomicstrata: PUBLISHER_KEY_2 } });
    expect(() => advancePublisherPins(verified(replacement), state)).toThrow(/without a valid rotation/);
  });

  it("accepts a dual-signed publisher rotation", () => {
    const state = advancePublisherPins(verified(), emptyPublisherPinState("official"));
    const rotated = parsedIndex({
      sequence: 2,
      publishers: { atomicstrata: PUBLISHER_KEY_2 },
      rotations: [signedRotation(2)],
    });
    expect(advancePublisherPins(verified(rotated), state).publishers.atomicstrata).toEqual(PUBLISHER_KEY_2);
  });

  it("accepts rotation history after skipped snapshots", () => {
    const state = advancePublisherPins(verified(), emptyPublisherPinState("official"));
    const current = parsedIndex({
      sequence: 4,
      publishers: { atomicstrata: PUBLISHER_KEY_3 },
      rotations: [signedRotation(2), signedSecondRotation(3)],
    });
    expect(advancePublisherPins(verified(current), state).publishers.atomicstrata).toEqual(PUBLISHER_KEY_3);
  });

  it("refuses incomplete or ambiguous rotation history", () => {
    const state = advancePublisherPins(verified(), emptyPublisherPinState("official"));
    const incomplete = parsedIndex({ sequence: 4, publishers: { atomicstrata: PUBLISHER_KEY_3 }, rotations: [signedSecondRotation(3)] });
    expect(() => advancePublisherPins(verified(incomplete), state)).toThrow(/valid rotation chain/);
    const ambiguous = parsedIndex({ sequence: 4, publishers: { atomicstrata: PUBLISHER_KEY_2 }, rotations: [signedRotation(2), signedRotation(3)] });
    expect(() => advancePublisherPins(verified(ambiguous), state)).toThrow(/ambiguous/);
  });

  it("refuses a rotation history whose effective sequence goes backward", () => {
    const state = advancePublisherPins(verified(), emptyPublisherPinState("official"));
    const reversed = parsedIndex({
      sequence: 4,
      publishers: { atomicstrata: PUBLISHER_KEY_3 },
      rotations: [signedRotation(3), signedSecondRotation(2)],
    });
    expect(() => advancePublisherPins(verified(reversed), state)).toThrow(/sequence is not increasing/);
  });

  it("accumulates revocations and refuses revoked evidence", () => {
    const digest = signedIndex().packages[0].payloadDigest;
    const index = parsedIndex({ revocations: [{ kind: "package", value: digest, reason: "compromised", revokedAt: "2026-07-12T01:00:00Z" }] });
    const state = advancePublisherPins(verified(index), emptyPublisherPinState("official"));
    expect(() => assertPackageNotRevoked(state, digest, "publisher-key-1")).toThrow(/package digest is revoked/);
  });

  it("refuses crossing tap trust domains", () => {
    expect(() => advancePublisherPins(verified(), emptyPublisherPinState("community"))).toThrow(/another tap/);
  });
});

function verified(index: ParsedTapIndex = parsedIndex()) {
  return verifyTapIndex(index, "official", TAP_KEY, new Date("2026-07-13T00:00:00Z"));
}
