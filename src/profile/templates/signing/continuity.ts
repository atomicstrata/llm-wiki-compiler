/**
 * @file src/profile/templates/signing/continuity.ts
 * @description Pure publisher-pin, coordinate-immutability, revocation, and
 * sequence transition logic for already tap-verified snapshots.
 */
import { verifyPublisherRotation } from "./verify.js";
import type { VerifiedTapIndex } from "./verify.js";
import type { PublisherKey, PublisherPinState, PublisherRotation } from "./types.js";

/** Empty operator state for a newly configured tap. */
export function emptyPublisherPinState(tap: string): PublisherPinState {
  return { tap, highestSequence: -1, publishers: {}, coordinates: {}, revokedPackages: [], revokedPublisherKeys: [] };
}

/** Accept a verified index into immutable operator continuity state. */
export function advancePublisherPins(index: VerifiedTapIndex, prior: PublisherPinState): PublisherPinState {
  if (index.tap !== prior.tap) throw new Error("publisher pin state belongs to another tap");
  if (index.sequence <= prior.highestSequence) throw new Error("tap index sequence rollback or replay");
  assertCoordinateContinuity(index, prior);
  const publishers = { ...prior.publishers };
  for (const [name, announced] of Object.entries(index.publishers)) {
    publishers[name] = acceptedPublisherKey(index, name, announced, publishers[name]);
  }
  const revokedPackages = union(prior.revokedPackages, revokedValues(index, "package"));
  const revokedPublisherKeys = union(prior.revokedPublisherKeys, revokedValues(index, "publisher-key"));
  assertNoRevokedActiveKeys(publishers, revokedPublisherKeys);
  return {
    tap: prior.tap,
    highestSequence: index.sequence,
    publishers,
    coordinates: { ...prior.coordinates, ...Object.fromEntries(index.packages.map((entry) => [entry.coordinate, entry.payloadDigest])) },
    revokedPackages,
    revokedPublisherKeys,
  };
}

/** Refuse packages or publisher keys revoked by any accepted snapshot. */
export function assertPackageNotRevoked(state: PublisherPinState, digest: string, publisherKeyId: string): void {
  if (state.revokedPackages.includes(digest)) throw new Error("package digest is revoked");
  if (state.revokedPublisherKeys.includes(publisherKeyId)) throw new Error("publisher key is revoked");
}

function acceptedPublisherKey(
  index: VerifiedTapIndex,
  publisher: string,
  announced: PublisherKey,
  pinned: PublisherKey | undefined,
): PublisherKey {
  if (!pinned) return announced;
  if (sameKey(pinned, announced)) return pinned;
  const rotation = matchingRotation(index.rotations, publisher, pinned, announced, index.sequence);
  if (!rotation) throw new Error(`publisher key changed without a valid rotation: ${publisher}`);
  verifyPublisherRotation(index.tap, rotation, pinned);
  return announced;
}

function matchingRotation(
  rotations: PublisherRotation[],
  publisher: string,
  from: PublisherKey,
  to: PublisherKey,
  sequence: number,
): PublisherRotation | undefined {
  return rotations.find((item) => item.publisher === publisher
    && item.fromKeyId === from.keyId
    && sameKey(item.toKey, to)
    && item.effectiveSequence === sequence);
}

function assertCoordinateContinuity(index: VerifiedTapIndex, prior: PublisherPinState): void {
  for (const entry of index.packages) {
    const existing = prior.coordinates[entry.coordinate];
    if (existing !== undefined && existing !== entry.payloadDigest) {
      throw new Error(`immutable coordinate remapped: ${entry.coordinate}`);
    }
  }
}

function assertNoRevokedActiveKeys(publishers: Record<string, PublisherKey>, revoked: string[]): void {
  for (const [publisher, key] of Object.entries(publishers)) {
    if (revoked.includes(key.keyId)) throw new Error(`active publisher key is revoked: ${publisher}`);
  }
}

function revokedValues(index: VerifiedTapIndex, kind: "package" | "publisher-key"): string[] {
  return index.revocations.filter((item) => item.kind === kind).map((item) => item.value);
}

function sameKey(left: PublisherKey, right: PublisherKey): boolean {
  return left.keyId === right.keyId && left.publicKey === right.publicKey;
}

function union(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])];
}
