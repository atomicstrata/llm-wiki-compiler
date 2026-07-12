/**
 * @file src/profile/templates/signing/verify.ts
 * @description Native Ed25519 verification for tap indexes, package claims,
 * payload digests, and publisher-key rotations.
 */
import { createPublicKey, verify } from "node:crypto";
import type { ProfileTemplatePackage } from "../types.js";
import { validateTemplatePackage } from "../validate.js";
import { canonicalBytes, canonicalDigest, packageClaim, rotationClaim, tapRotationClaim } from "./canonical.js";
import { parseTemplateCoordinate } from "./protocol.js";
import type {
  Ed25519Signature,
  PublisherKey,
  PublisherRotation,
  PublisherPinState,
  SignedPackageEnvelope,
  SignedTapIndex,
  TapKeyRotation,
} from "./types.js";

declare const VERIFIED_TAP_INDEX: unique symbol;
/** Tap index whose signature, identity, and freshness were verified. */
export type VerifiedTapIndex = SignedTapIndex & { readonly [VERIFIED_TAP_INDEX]: true };

/** Typed refusal preserving the failed provenance layer. */
class TemplateVerificationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TemplateVerificationError";
  }
}

/** Verify a tap snapshot against an explicitly trusted tap key and identity. */
export function verifyTapIndex(
  index: SignedTapIndex,
  expectedTap: string,
  trustedKey: PublisherKey,
  now = new Date(),
): VerifiedTapIndex {
  if (index.tap !== expectedTap) refuse("wrong-tap", `expected tap ${expectedTap}, received ${index.tap}`);
  if (index.signature.keyId !== trustedKey.keyId) refuse("wrong-key", "tap signature key does not match the trusted key");
  if (Date.parse(index.expiresAt) <= now.getTime()) refuse("expired", "tap index is expired");
  const { signature, ...claim } = index;
  verifySignature(canonicalBytes(claim), signature, trustedKey, "tap-signature");
  return index as VerifiedTapIndex;
}

/** Verify one package against the exact signed index entry and publisher key. */
export function verifySignedPackage(
  envelope: SignedPackageEnvelope,
  index: VerifiedTapIndex,
  state: PublisherPinState,
  currentVersion: string,
): ProfileTemplatePackage {
  if (state.tap !== index.tap || state.highestSequence < index.sequence) {
    refuse("unaccepted-index", "package index has not been accepted into continuity state");
  }
  const entry = index.packages.find((candidate) => candidate.coordinate === envelope.coordinate);
  if (!entry) refuse("unknown-coordinate", "package coordinate is absent from the verified index");
  if (envelope.coordinate !== entry.coordinate) refuse("wrong-coordinate", "package coordinate differs from index entry");
  const coordinate = parseTemplateCoordinate(envelope.coordinate);
  if (coordinate.publisher !== entry.publisher) refuse("wrong-publisher", "coordinate publisher differs from index entry");
  const publisherKey = index.publishers[entry.publisher];
  if (!publisherKey) refuse("unknown-publisher", "verified index has no key for the package publisher");
  assertEvidenceNotRevoked(state, entry.payloadDigest, publisherKey.keyId);
  const computed = canonicalDigest(envelope.payload);
  if (computed !== envelope.payloadDigest || computed !== entry.payloadDigest) refuse("wrong-digest", "package payload digest does not match signed metadata");
  verifySignature(canonicalBytes(packageClaim(envelope.coordinate, computed)), envelope.publisherSignature, publisherKey, "publisher-signature");
  const pkg = validateTemplatePackage(envelope.payload, { currentVersion, sourceType: "remote" });
  if (pkg.templateId !== coordinate.templateId || pkg.version !== coordinate.version || pkg.publisher !== coordinate.publisher) {
    refuse("wrong-identity", "package payload identity differs from its coordinate");
  }
  return pkg;
}

/** Require both predecessor and successor signatures on a rotation claim. */
export function verifyPublisherRotation(
  tap: string,
  rotation: PublisherRotation,
  currentKey: PublisherKey,
): void {
  if (rotation.fromKeyId !== currentKey.keyId) refuse("rotation-predecessor", "rotation predecessor does not match the pinned key");
  if (rotation.toKey.keyId === currentKey.keyId) refuse("rotation-key-id", "rotation successor must use a new key id");
  if (rotation.oldSignature.keyId !== currentKey.keyId) refuse("rotation-old-key", "old rotation signature uses the wrong key");
  if (rotation.newSignature.keyId !== rotation.toKey.keyId) refuse("rotation-new-key", "new rotation signature uses the wrong key");
  const claim = canonicalBytes(rotationClaim(tap, rotation));
  verifySignature(claim, rotation.oldSignature, currentKey, "rotation-old-signature");
  verifySignature(claim, rotation.newSignature, rotation.toKey, "rotation-new-signature");
}

/** Require predecessor and successor signatures before replacing a tap root. */
export function verifyTapKeyRotation(
  tap: string,
  rotation: TapKeyRotation,
  currentKey: PublisherKey,
): PublisherKey {
  if (rotation.fromKeyId !== currentKey.keyId) refuse("tap-rotation-predecessor", "tap rotation predecessor does not match the trusted key");
  if (rotation.toKey.keyId === currentKey.keyId) refuse("tap-rotation-key-id", "tap rotation successor must use a new key id");
  if (rotation.oldSignature.keyId !== currentKey.keyId) refuse("tap-rotation-old-key", "old tap rotation signature uses the wrong key");
  if (rotation.newSignature.keyId !== rotation.toKey.keyId) refuse("tap-rotation-new-key", "new tap rotation signature uses the wrong key");
  const claim = canonicalBytes(tapRotationClaim(tap, rotation));
  verifySignature(claim, rotation.oldSignature, currentKey, "tap-rotation-old-signature");
  verifySignature(claim, rotation.newSignature, rotation.toKey, "tap-rotation-new-signature");
  return rotation.toKey;
}

function verifySignature(bytes: Buffer, signature: Ed25519Signature, key: PublisherKey, code: string): void {
  if (signature.algorithm !== "ed25519") refuse("algorithm", "only Ed25519 signatures are supported");
  if (signature.keyId !== key.keyId) refuse("wrong-key", "signature key id does not match its verification key");
  try {
    const publicKey = createPublicKey({ key: Buffer.from(key.publicKey, "base64"), format: "der", type: "spki" });
    if (publicKey.asymmetricKeyType !== "ed25519") refuse("malformed-key", "verification key is not Ed25519");
    const signatureBytes = Buffer.from(signature.value, "base64");
    if (signatureBytes.length !== 64 || !verify(null, bytes, publicKey, signatureBytes)) refuse(code, "signature verification failed");
  } catch (error) {
    if (error instanceof TemplateVerificationError) throw error;
    refuse("malformed-key", "Ed25519 public key is malformed");
  }
}

function assertEvidenceNotRevoked(state: PublisherPinState, digest: string, publisherKeyId: string): void {
  if (state.revokedPackages.includes(digest)) refuse("revoked-package", "package digest is revoked");
  if (state.revokedPublisherKeys.includes(publisherKeyId)) refuse("revoked-publisher", "publisher key is revoked");
}

function refuse(code: string, message: string): never {
  throw new TemplateVerificationError(code, message);
}
