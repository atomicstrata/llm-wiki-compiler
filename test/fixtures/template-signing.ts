/**
 * @file test/fixtures/template-signing.ts
 * @description Deterministic Ed25519 keys and signed protocol records used only
 * by offline template-signing tests.
 */
import { createPrivateKey, sign } from "node:crypto";
import { canonicalBytes, canonicalDigest, packageClaim, rotationClaim, tapRotationClaim } from "../../src/profile/templates/signing/canonical.js";
import {
  parseSignedPackage,
  parseSignedTapIndex,
  type ParsedSignedPackage,
  type ParsedTapIndex,
} from "../../src/profile/templates/signing/protocol.js";
import type {
  Ed25519Signature,
  PublisherKey,
  PublisherRotation,
  SignedPackageEnvelope,
  SignedTapIndex,
  TapKeyRotation,
} from "../../src/profile/templates/signing/types.js";
import type { ProfileTemplatePackage } from "../../src/profile/templates/types.js";

const PRIVATE_KEYS = {
  tap: "MC4CAQAwBQYDK2VwBCIEIJze3m6WcKjBrVlTaqQkGbCbMSkdw3vTKRdmdaEpgJ30",
  publisher: "MC4CAQAwBQYDK2VwBCIEIDO22AsRnfvQCs+w7bG+PYxSidQvcFRM0yw9f8ckqhV1",
  publisher2: "MC4CAQAwBQYDK2VwBCIEILg07GXy1Qttpfks9JixoMEAct1mBKqusrVtTbdz9+RT",
} as const;

export const TAP_KEY: PublisherKey = {
  keyId: "tap-key-1",
  publicKey: "MCowBQYDK2VwAyEA+Zh7GM2+2PTzR+DGzIIMyf9RW3z8iPX+y0ToR7vFF7Q=",
};
export const PUBLISHER_KEY: PublisherKey = {
  keyId: "publisher-key-1",
  publicKey: "MCowBQYDK2VwAyEALxhYHe2T84VftJ/HrDCirlutF6xJg/EoZYCrQYBq+q8=",
};
export const PUBLISHER_KEY_2: PublisherKey = {
  keyId: "publisher-key-2",
  publicKey: "MCowBQYDK2VwAyEA1x7Pt3kbQIlLnFgNnx382iiEsA4v/h1YqKWzzIkYYuU=",
};
export const PUBLISHER_KEY_3: PublisherKey = { ...TAP_KEY, keyId: "publisher-key-3" };
export const TAP_KEY_2: PublisherKey = { ...PUBLISHER_KEY_2, keyId: "tap-key-2" };

export const COORDINATE = "official/atomicstrata/team@1.0.0";

export function remotePackage(): ProfileTemplatePackage {
  return {
    schemaVersion: 1,
    templateId: "team",
    version: "1.0.0",
    displayName: "Team",
    publisher: "atomicstrata",
    sourceType: "remote",
    license: "MIT",
    minLlmwikiVersion: "1.0.0",
    profile: { schemaVersion: 1, profileId: "team", displayName: "Team", entities: { items: { directory: "wiki/items" } } },
  };
}

export function signedPackage(payload = remotePackage()): SignedPackageEnvelope {
  const payloadDigest = canonicalDigest(payload);
  return {
    schemaVersion: 1,
    coordinate: COORDINATE,
    payload,
    payloadDigest,
    publisherSignature: signClaim(packageClaim(COORDINATE, payloadDigest), "publisher", PUBLISHER_KEY.keyId),
  };
}

export function parsedPackage(payload = remotePackage()): ParsedSignedPackage {
  return parseSignedPackage(JSON.stringify(signedPackage(payload)));
}

export function signedIndex(overrides: Partial<SignedTapIndex> = {}): SignedTapIndex {
  const envelope = signedPackage();
  const unsigned: Omit<SignedTapIndex, "signature"> = {
    schemaVersion: 1,
    tap: "official",
    sequence: 1,
    generatedAt: "2026-07-12T00:00:00Z",
    expiresAt: "2027-07-12T00:00:00Z",
    publishers: { atomicstrata: PUBLISHER_KEY },
    packages: [{ coordinate: COORDINATE, publisher: "atomicstrata", payloadDigest: envelope.payloadDigest }],
    rotations: [],
    revocations: [],
    ...withoutSignature(overrides),
  };
  return { ...unsigned, signature: signClaim(unsigned, "tap", TAP_KEY.keyId) };
}

export function parsedIndex(overrides: Partial<SignedTapIndex> = {}): ParsedTapIndex {
  return parseSignedTapIndex(JSON.stringify(signedIndex(overrides)));
}

export function signedRotation(sequence = 2): PublisherRotation {
  const base = {
    publisher: "atomicstrata",
    fromKeyId: PUBLISHER_KEY.keyId,
    toKey: PUBLISHER_KEY_2,
    effectiveSequence: sequence,
  };
  const claim = rotationClaim("official", base);
  return {
    ...base,
    oldSignature: signClaim(claim, "publisher", PUBLISHER_KEY.keyId),
    newSignature: signClaim(claim, "publisher2", PUBLISHER_KEY_2.keyId),
  };
}

export function signedSecondRotation(sequence = 3): PublisherRotation {
  const base = {
    publisher: "atomicstrata",
    fromKeyId: PUBLISHER_KEY_2.keyId,
    toKey: PUBLISHER_KEY_3,
    effectiveSequence: sequence,
  };
  const claim = rotationClaim("official", base);
  return {
    ...base,
    oldSignature: signClaim(claim, "publisher2", PUBLISHER_KEY_2.keyId),
    newSignature: signClaim(claim, "tap", PUBLISHER_KEY_3.keyId),
  };
}

export function signedReturnRotation(sequence = 3): PublisherRotation {
  const base = {
    publisher: "atomicstrata",
    fromKeyId: PUBLISHER_KEY_2.keyId,
    toKey: PUBLISHER_KEY,
    effectiveSequence: sequence,
  };
  const claim = rotationClaim("official", base);
  return {
    ...base,
    oldSignature: signClaim(claim, "publisher2", PUBLISHER_KEY_2.keyId),
    newSignature: signClaim(claim, "publisher", PUBLISHER_KEY.keyId),
  };
}

export function signedTapRotation(sequence = 2): TapKeyRotation {
  const base = { fromKeyId: TAP_KEY.keyId, toKey: TAP_KEY_2, effectiveSequence: sequence };
  const claim = tapRotationClaim("official", base);
  return {
    ...base,
    oldSignature: signClaim(claim, "tap", TAP_KEY.keyId),
    newSignature: signClaim(claim, "publisher2", TAP_KEY_2.keyId),
  };
}

function signClaim(value: unknown, key: keyof typeof PRIVATE_KEYS, keyId: string): Ed25519Signature {
  const privateKey = createPrivateKey({ key: Buffer.from(PRIVATE_KEYS[key], "base64"), format: "der", type: "pkcs8" });
  return { keyId, algorithm: "ed25519", value: sign(null, canonicalBytes(value), privateKey).toString("base64") };
}

function withoutSignature(overrides: Partial<SignedTapIndex>): Partial<Omit<SignedTapIndex, "signature">> {
  const { signature: _signature, ...rest } = overrides;
  return rest;
}
