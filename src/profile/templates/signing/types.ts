/**
 * @file src/profile/templates/signing/types.ts
 * @description Offline signed-template protocol DTOs. These records establish
 * provenance only; they never authorize profile loading or installation.
 */
import type { ProfileTemplatePackage } from "../types.js";

export interface Ed25519Signature {
  keyId: string;
  algorithm: "ed25519";
  value: string;
}

export interface PublisherKey {
  keyId: string;
  publicKey: string;
}

export interface SignedPackageEnvelope {
  schemaVersion: 1;
  coordinate: string;
  payload: ProfileTemplatePackage;
  payloadDigest: string;
  publisherSignature: Ed25519Signature;
}

export interface TapPackageEntry {
  coordinate: string;
  publisher: string;
  payloadDigest: string;
}

export interface PublisherRotation {
  publisher: string;
  fromKeyId: string;
  toKey: PublisherKey;
  effectiveSequence: number;
  oldSignature: Ed25519Signature;
  newSignature: Ed25519Signature;
}

export interface TapKeyRotation {
  fromKeyId: string;
  toKey: PublisherKey;
  effectiveSequence: number;
  oldSignature: Ed25519Signature;
  newSignature: Ed25519Signature;
}

export interface TapRevocation {
  kind: "package" | "publisher-key";
  value: string;
  reason: string;
  revokedAt: string;
}

export interface SignedTapIndex {
  schemaVersion: 1;
  tap: string;
  sequence: number;
  generatedAt: string;
  expiresAt: string;
  publishers: Record<string, PublisherKey>;
  packages: TapPackageEntry[];
  rotations: PublisherRotation[];
  tapKeyRotation?: TapKeyRotation;
  revocations: TapRevocation[];
  signature: Ed25519Signature;
}

export interface PublisherPinState {
  tap: string;
  highestSequence: number;
  publishers: Record<string, PublisherKey>;
  coordinates: Record<string, string>;
  revokedPackages: string[];
  revokedPublisherKeys: string[];
}
