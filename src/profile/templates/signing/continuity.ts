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
  return { tap, highestSequence: -1, publishers: {}, keyHistory: {}, coordinates: {}, revokedPackages: [], revokedPublisherKeys: [] };
}

/** Accept a verified index into immutable operator continuity state. */
export function advancePublisherPins(index: VerifiedTapIndex, prior: PublisherPinState): PublisherPinState {
  if (index.tap !== prior.tap) throw new Error("publisher pin state belongs to another tap");
  if (index.sequence <= prior.highestSequence) throw new Error("tap index sequence rollback or replay");
  assertCoordinateContinuity(index, prior);
  const publishers = { ...prior.publishers };
  const keyHistory = { ...prior.keyHistory };
  for (const [name, announced] of Object.entries(index.publishers)) {
    const accepted = acceptedPublisherKeys(index, name, announced, publishers[name]);
    accepted.forEach((key, index) => registerKey(keyHistory, name, key, index === 0));
    publishers[name] = accepted.at(-1)!;
  }
  const revokedPackages = union(prior.revokedPackages, revokedValues(index, "package"));
  const revokedPublisherKeys = union(prior.revokedPublisherKeys, revokedValues(index, "publisher-key"));
  assertNoRevokedActiveKeys(publishers, revokedPublisherKeys);
  return {
    tap: prior.tap,
    highestSequence: index.sequence,
    publishers,
    keyHistory,
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

function acceptedPublisherKeys(
  index: VerifiedTapIndex,
  publisher: string,
  announced: PublisherKey,
  pinned: PublisherKey | undefined,
): PublisherKey[] {
  if (!pinned) return [announced];
  if (sameKey(pinned, announced)) return [pinned];
  return followRotationChain(index, publisher, pinned, announced);
}

function followRotationChain(
  index: VerifiedTapIndex,
  publisher: string,
  pinned: PublisherKey,
  announced: PublisherKey,
): PublisherKey[] {
  const rotations = rotationMap(index.rotations, publisher, index.sequence);
  let current = pinned;
  let previousSequence = -1;
  const visited = new Set<string>([current.keyId]);
  const accepted = [current];
  while (!sameKey(current, announced)) {
    const rotation = rotations.get(current.keyId);
    if (!rotation) throw new Error(`publisher key changed without a valid rotation chain: ${publisher}`);
    if (rotation.effectiveSequence <= previousSequence) throw new Error(`publisher rotation sequence is not increasing: ${publisher}`);
    verifyPublisherRotation(index.tap, rotation, current);
    if (visited.has(rotation.toKey.keyId)) throw new Error(`publisher rotation cycle: ${publisher}`);
    visited.add(rotation.toKey.keyId);
    current = rotation.toKey;
    accepted.push(current);
    previousSequence = rotation.effectiveSequence;
  }
  return accepted;
}

function registerKey(
  history: PublisherPinState["keyHistory"],
  publisher: string,
  key: PublisherKey,
  allowExisting: boolean,
): void {
  const existing = history[key.keyId];
  if (existing && (existing.publisher !== publisher || existing.publicKey !== key.publicKey)) {
    throw new Error(`publisher key id was rebound: ${key.keyId}`);
  }
  if (existing && !allowExisting) throw new Error(`publisher rotation reuses historical key id: ${key.keyId}`);
  history[key.keyId] = { publisher, publicKey: key.publicKey };
}

function rotationMap(
  rotations: PublisherRotation[],
  publisher: string,
  currentSequence: number,
): Map<string, PublisherRotation> {
  const result = new Map<string, PublisherRotation>();
  for (const rotation of rotations) {
    if (rotation.publisher !== publisher || rotation.effectiveSequence > currentSequence) continue;
    if (result.has(rotation.fromKeyId)) throw new Error(`ambiguous publisher rotation chain: ${publisher}`);
    result.set(rotation.fromKeyId, rotation);
  }
  return result;
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
