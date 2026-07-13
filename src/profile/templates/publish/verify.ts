/**
 * @file src/profile/templates/publish/verify.ts
 * @description Pure orchestration for offline verification of one publisher
 * distribution snapshot. Cryptographic, parsing, continuity, revocation, and
 * template validation decisions remain in the production signing modules.
 */
import packageJson from "../../../../package.json" with { type: "json" };
import { advancePublisherPins, emptyPublisherPinState } from "../signing/continuity.js";
import { parseSignedPackage, parseSignedTapIndex } from "../signing/protocol.js";
import { assertEd25519PublicKey, verifySignedPackage, verifyTapIndex } from "../signing/verify.js";
import {
  assertExactDistributionTree,
  closeDistributionPaths,
  decodeCanonicalBase64Key,
  readDistributionIndex,
  readDistributionPackage,
  readTapPublicKey,
  resolveDistributionPaths,
} from "./filesystem.js";

const TERMINAL_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const MAX_KEY_ID_BYTES = 4_096;
/** Ed25519 SPKI DER length; a canonical public key decodes to exactly this. */
const ED25519_SPKI_DER_BYTES = 44;

/** Public, versioned result that deliberately excludes local paths and evidence bytes. */
export interface DistributionVerificationResult {
  schemaVersion: 1;
  verified: true;
  scope: "snapshot";
  continuity: "not_applicable_no_rotations";
  tap: string;
  sequence: number;
  tapKeyId: string;
  packageCount: number;
}

/** Verify a complete static snapshot against an independently selected tap key. */
export async function verifyPublisherDistribution(
  directory: string,
  expectedTap: string,
  keyId: string,
  keyFile: string,
): Promise<DistributionVerificationResult> {
  assertSafeTap(expectedTap);
  assertSafeKeyId(keyId);
  const paths = await resolveDistributionPaths(directory);
  try {
    const [indexText, publicKey] = await Promise.all([
      readDistributionIndex(paths),
      readTapPublicKey(keyFile),
    ]);
    const trustedKey = bindTrustedTapKey(keyId, publicKey);
    const parsed = parseSignedTapIndex(indexText);
    assertSnapshotContinuityScope(parsed);
    const verified = verifyTapIndex(parsed, expectedTap, trustedKey);
    const pins = advancePublisherPins(verified, emptyPublisherPinState(verified.tap));
    const digests = verified.packages.map((entry) => entry.payloadDigest);
    await assertExactDistributionTree(paths, digests);
    for (const digest of digests) {
      const envelope = parseSignedPackage(await readDistributionPackage(paths, digest));
      if (envelope.payloadDigest !== digest) {
        throw new Error("package at content-addressed path does not match its signed digest entry");
      }
      verifySignedPackage(envelope, verified, pins, packageJson.version);
    }
    await assertExactDistributionTree(paths, digests);
    return successResult(verified.tap, verified.sequence, keyId, verified.packages.length);
  } finally {
    await closeDistributionPaths(paths);
  }
}

function bindTrustedTapKey(keyId: string, publicKey: string): { keyId: string; publicKey: string } {
  const decoded = decodeCanonicalBase64Key(publicKey, "tap key file");
  if (decoded.length !== ED25519_SPKI_DER_BYTES) {
    throw new Error("tap key file must be a base64 SPKI DER Ed25519 public key");
  }
  const trustedKey = { keyId, publicKey };
  assertEd25519PublicKey(trustedKey);
  return trustedKey;
}

function assertSafeKeyId(keyId: string): void {
  if (keyId.length === 0 || Buffer.byteLength(keyId, "utf8") > MAX_KEY_ID_BYTES) {
    throw new Error("tap key id must be a bounded non-empty string");
  }
  if (TERMINAL_CONTROL.test(keyId)) {
    throw new Error("tap key id must not contain terminal control characters");
  }
}

function assertSafeTap(tap: string): void {
  if (Buffer.byteLength(tap, "utf8") > 4_096 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tap)) {
    throw new Error("expected tap must be a bounded slug-safe identity");
  }
}

function assertSnapshotContinuityScope(index: ReturnType<typeof parseSignedTapIndex>): void {
  if (index.rotations.length > 0 || index.tapKeyRotation !== undefined) {
    throw new Error("snapshot continuity cannot verify publisher or tap-key rotations");
  }
}

function successResult(
  tap: string,
  sequence: number,
  tapKeyId: string,
  packageCount: number,
): DistributionVerificationResult {
  return {
    schemaVersion: 1,
    verified: true,
    scope: "snapshot",
    continuity: "not_applicable_no_rotations",
    tap,
    sequence,
    tapKeyId,
    packageCount,
  };
}
