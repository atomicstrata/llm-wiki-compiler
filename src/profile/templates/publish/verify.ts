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
  readDistributionIndex,
  readDistributionPackage,
  readTapPublicKey,
  resolveDistributionPaths,
} from "./filesystem.js";

const TERMINAL_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const MAX_KEY_ID_BYTES = 4_096;

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
  keyId: string,
  keyFile: string,
): Promise<DistributionVerificationResult> {
  assertSafeKeyId(keyId);
  const paths = await resolveDistributionPaths(directory);
  const [indexText, publicKey] = await Promise.all([
    readDistributionIndex(paths),
    readTapPublicKey(keyFile),
  ]);
  const trustedKey = { keyId, publicKey };
  assertEd25519PublicKey(trustedKey);
  const parsed = parseSignedTapIndex(indexText);
  assertSnapshotContinuityScope(parsed);
  const verified = verifyTapIndex(parsed, parsed.tap, trustedKey);
  const pins = advancePublisherPins(verified, emptyPublisherPinState(verified.tap));
  const digests = verified.packages.map((entry) => entry.payloadDigest);
  await assertExactDistributionTree(paths, digests);
  for (const digest of digests) {
    const envelope = parseSignedPackage(await readDistributionPackage(paths, digest));
    verifySignedPackage(envelope, verified, pins, packageJson.version);
  }
  await assertExactDistributionTree(paths, digests);
  return successResult(verified.tap, verified.sequence, keyId, verified.packages.length);
}

function assertSafeKeyId(keyId: string): void {
  if (keyId.length === 0 || Buffer.byteLength(keyId, "utf8") > MAX_KEY_ID_BYTES) {
    throw new Error("tap key id must be a bounded non-empty string");
  }
  if (TERMINAL_CONTROL.test(keyId)) {
    throw new Error("tap key id must not contain terminal control characters");
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
