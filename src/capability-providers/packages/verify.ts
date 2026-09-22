/**
 * @file src/capability-providers/packages/verify.ts
 * @description Provider package verification composed from the existing TAP
 * continuity, canonicalization, and Ed25519 authorities. Signatures prove
 * provenance only; installation and later grants remain separate decisions.
 */
import { canonicalBytes, canonicalDigest, packageClaim } from "../../profile/templates/signing/canonical.js";
import { advancePublisherPins } from "../../profile/templates/signing/continuity.js";
import type { ParsedTapIndex } from "../../profile/templates/signing/protocol.js";
import type { PublisherKey, PublisherPinState } from "../../profile/templates/signing/types.js";
import { verifyEd25519Signature, verifyTapIndex, type VerifiedTapIndex } from "../../profile/templates/signing/verify.js";
import { compareTemplateVersions } from "../../profile/templates/registry.js";
import { parseProviderCoordinate, parseSemanticVersion } from "../ids.js";
import type { Sha256Digest } from "../types.js";
import type {
  CapabilityProviderPackageV1, ParsedProviderPackageEnvelope, ProviderManifestV1,
} from "./protocol.js";

export interface VerifyProviderDistributionRequest {
  readonly envelope: ParsedProviderPackageEnvelope;
  readonly index: ParsedTapIndex;
  readonly expectedTap: string;
  readonly trustedTapKey: PublisherKey;
  readonly priorPins: PublisherPinState;
  readonly currentVersion: string;
  readonly now?: Date;
}

export interface VerifiedProviderDistribution {
  readonly envelope: ParsedProviderPackageEnvelope;
  readonly payload: CapabilityProviderPackageV1;
  readonly manifest: ProviderManifestV1;
  readonly manifestDigest: Sha256Digest;
  readonly index: VerifiedTapIndex;
  readonly pins: PublisherPinState;
  readonly publisherKeyId: string;
}

export interface VerifyAcceptedProviderDistributionRequest {
  readonly envelope: ParsedProviderPackageEnvelope;
  readonly index: VerifiedTapIndex;
  readonly pins: PublisherPinState;
  readonly currentVersion: string;
}

/** Verify exact index membership, continuity, signature, digest, and identity. */
export function verifyProviderDistribution(
  request: VerifyProviderDistributionRequest,
): VerifiedProviderDistribution {
  const index = verifyTapIndex(
    request.index, request.expectedTap, request.trustedTapKey, request.now,
  );
  const pins = advancePublisherPins(index, request.priorPins);
  return verifyAcceptedProviderDistribution({
    envelope: request.envelope, index, pins, currentVersion: request.currentVersion,
  });
}

/** Reverify a package against an already accepted index and pin authority. */
export function verifyAcceptedProviderDistribution(
  request: VerifyAcceptedProviderDistributionRequest,
): VerifiedProviderDistribution {
  const { index, pins } = request;
  if (pins.tap !== index.tap || pins.highestSequence !== index.sequence) {
    throw new Error("provider index is not the accepted continuity sequence");
  }
  const entry = index.packages.find((candidate) => candidate.coordinate === request.envelope.coordinate);
  if (!entry) throw new Error("provider coordinate is absent from the verified index");
  const coordinate = parseProviderCoordinate(request.envelope.coordinate);
  if (coordinate.tap !== index.tap || coordinate.publisher !== entry.publisher) {
    throw new Error("provider coordinate identity differs from the verified index");
  }
  const publisherKey = index.publishers[entry.publisher];
  if (!publisherKey) throw new Error("provider publisher key is unavailable");
  assertActive(pins, entry.payloadDigest, publisherKey.keyId);
  verifyPayload(request.envelope, entry.payloadDigest, publisherKey);
  verifyIdentity(request.envelope.payload, coordinate, request.currentVersion);
  return Object.freeze({
    envelope: request.envelope, payload: request.envelope.payload,
    manifest: request.envelope.payload.manifest,
    manifestDigest: canonicalDigest(request.envelope.payload.manifest) as Sha256Digest,
    index,
    pins,
    publisherKeyId: publisherKey.keyId,
  });
}

function verifyPayload(
  envelope: ParsedProviderPackageEnvelope,
  indexDigest: string,
  publisherKey: PublisherKey,
): void {
  const computed = canonicalDigest(envelope.payload);
  if (computed !== envelope.payloadDigest || computed !== indexDigest) {
    throw new Error("provider package digest differs from signed metadata");
  }
  verifyEd25519Signature(
    canonicalBytes(packageClaim(envelope.coordinate, computed)),
    envelope.publisherSignature,
    publisherKey,
    "provider-publisher-signature",
  );
}

function verifyIdentity(
  payload: CapabilityProviderPackageV1,
  coordinate: ReturnType<typeof parseProviderCoordinate>,
  currentVersion: string,
): void {
  const hostVersion = parseSemanticVersion(currentVersion);
  const manifest = payload.manifest;
  if (payload.providerId !== coordinate.providerId
    || payload.providerVersion !== coordinate.providerVersion
    || payload.publisher !== coordinate.publisher
    || manifest.providerId !== payload.providerId
    || manifest.providerVersion !== payload.providerVersion) {
    throw new Error("provider package identity differs from its coordinate or manifest");
  }
  if (compareTemplateVersions(hostVersion, payload.minLlmwikiVersion) < 0) {
    throw new Error("provider package requires a newer llmwiki version");
  }
}

function assertActive(pins: PublisherPinState, digest: string, keyId: string): void {
  if (pins.revokedPackages.includes(digest)) throw new Error("provider package is revoked");
  if (pins.revokedPublisherKeys.includes(keyId)) throw new Error("provider publisher key is revoked");
}
