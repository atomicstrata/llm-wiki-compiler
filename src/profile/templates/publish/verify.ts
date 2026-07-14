/**
 * @file src/profile/templates/publish/verify.ts
 * @description Pure orchestration for offline verification of one publisher
 * distribution snapshot. Cryptographic, parsing, continuity, revocation, and
 * template validation decisions remain in the production signing modules.
 */
import packageJson from "../../../../package.json" with { type: "json" };
import { createHash } from "node:crypto";
import { advancePublisherPins, emptyPublisherPinState } from "../signing/continuity.js";
import { parseSignedPackage, parseSignedTapIndex } from "../signing/protocol.js";
import { assertEd25519PublicKey, verifySignedPackage, verifyTapIndex } from "../signing/verify.js";
import {
  assertExactDistributionTree,
  closeDistributionPaths,
  decodeCanonicalBase64Key,
  decodeTapPublicKey,
  openExactDistributionTreeGuard,
  openTapPublicKey,
  readDistributionIndexBytes,
  readDistributionPackageBytes,
  resolveDistributionPaths,
  type SelectedTapPublicKey,
  type DistributionTreeGuard,
} from "./filesystem.js";
import { decodeUtf8 } from "./bounded-read.js";

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

export interface DistributionVerificationOptions {
  /** Test-only seam for replacing already-verified leaves before verdict binding. */
  beforeFinalBindingCheckForTest?: () => Promise<void>;
  /** Test-only seam after final enumeration and leaf verification. */
  beforeFinalVerdictForTest?: () => Promise<void>;
}

/** Verify a complete static snapshot against an independently selected tap key. */
export async function verifyPublisherDistribution(
  directory: string,
  expectedTap: string,
  keyId: string,
  keyFile: string,
  options: DistributionVerificationOptions = {},
): Promise<DistributionVerificationResult> {
  assertSafeTap(expectedTap);
  assertSafeKeyId(keyId);
  const paths = await resolveDistributionPaths(directory);
  let selectedKey: SelectedTapPublicKey | undefined;
  let treeGuard: DistributionTreeGuard | undefined;
  try {
    selectedKey = await openTapPublicKey(keyFile);
    const snapshot = await verifyIndex(paths, selectedKey, expectedTap, keyId);
    const { verified, digests, packageBytesSha256 } = snapshot;
    await assertExactDistributionTree(paths, digests);
    await verifyPackages(paths, snapshot);
    if (options.beforeFinalBindingCheckForTest) await options.beforeFinalBindingCheckForTest();
    treeGuard = await openExactDistributionTreeGuard(paths, digests);
    if (options.beforeFinalVerdictForTest) await options.beforeFinalVerdictForTest();
    await treeGuard.assertUnchanged();
    await assertVerifiedBytesRemainSelected(
      paths,
      selectedKey,
      snapshot.indexBytesSha256,
      snapshot.keyBytesSha256,
      packageBytesSha256,
    );
    return successResult(verified.tap, verified.sequence, keyId, verified.packages.length);
  } finally {
    await treeGuard?.close();
    await selectedKey?.close();
    await closeDistributionPaths(paths);
  }
}

interface VerifiedSnapshot {
  verified: ReturnType<typeof verifyTapIndex>;
  pins: ReturnType<typeof advancePublisherPins>;
  digests: string[];
  indexBytesSha256: string;
  keyBytesSha256: string;
  packageBytesSha256: Map<string, string>;
}

async function verifyIndex(
  paths: Awaited<ReturnType<typeof resolveDistributionPaths>>,
  selectedKey: SelectedTapPublicKey,
  expectedTap: string,
  keyId: string,
): Promise<VerifiedSnapshot> {
  const [indexBytes, keyBytes] = await Promise.all([
    readDistributionIndexBytes(paths), selectedKey.readBytes(),
  ]);
  const parsed = parseSignedTapIndex(decodeUtf8(indexBytes, "index"));
  const publicKey = decodeTapPublicKey(keyBytes);
  const verified = verifyTapIndex(parsed, expectedTap, bindTrustedTapKey(keyId, publicKey));
  assertSnapshotContinuityScope(parsed);
  return {
    verified,
    pins: advancePublisherPins(verified, emptyPublisherPinState(verified.tap)),
    digests: verified.packages.map((entry) => entry.payloadDigest),
    indexBytesSha256: contentSha256(indexBytes),
    keyBytesSha256: contentSha256(keyBytes),
    packageBytesSha256: new Map(),
  };
}

async function verifyPackages(
  paths: Awaited<ReturnType<typeof resolveDistributionPaths>>,
  snapshot: VerifiedSnapshot,
): Promise<void> {
  for (const digest of snapshot.digests) {
    const bytes = await readDistributionPackageBytes(paths, digest);
    const envelope = parseSignedPackage(decodeUtf8(bytes, "package"));
    if (envelope.payloadDigest !== digest) {
      throw new Error("package at content-addressed path does not match its signed digest entry");
    }
    verifySignedPackage(envelope, snapshot.verified, snapshot.pins, packageJson.version);
    snapshot.packageBytesSha256.set(digest, contentSha256(bytes));
  }
}

async function assertVerifiedBytesRemainSelected(
  paths: Awaited<ReturnType<typeof resolveDistributionPaths>>,
  selectedKey: SelectedTapPublicKey,
  indexSha256: string,
  keySha256: string,
  packages: ReadonlyMap<string, string>,
): Promise<void> {
  if (contentSha256(await readDistributionIndexBytes(paths)) !== indexSha256) {
    throw new Error("index content changed after its bytes were verified");
  }
  if (contentSha256(await selectedKey.readBytes()) !== keySha256) {
    throw new Error("tap key content changed after its bytes were verified");
  }
  for (const [digest, expectedSha256] of packages) {
    if (contentSha256(await readDistributionPackageBytes(paths, digest)) !== expectedSha256) {
      throw new Error("package content changed after its bytes were verified");
    }
  }
}

function contentSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
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

/**
 * A snapshot can only accept rotations that are already RETAINED HISTORY
 * (`effectiveSequence < index.sequence`). Those are inert here: a fresh pin never walks a
 * chain, because `acceptedPublisherKeys` returns the announced key when nothing is pinned.
 *
 * Anything at or after this sequence is unprovable from a latest-snapshot-only directory —
 * verifying it needs the key a client pinned from the PREVIOUS release, which this directory
 * does not have. A tap-key rotation is always unprovable for the same reason.
 *
 * Refusing retained history too (the original rule) made this command permanently unusable
 * for every tap that had ever rotated a key, because rotations are re-emitted in every index
 * forever.
 */
function assertSnapshotContinuityScope(index: ReturnType<typeof parseSignedTapIndex>): void {
  const unprovable = index.rotations.some((rotation) => rotation.effectiveSequence >= index.sequence);
  if (unprovable || index.tapKeyRotation !== undefined) {
    throw new Error("snapshot continuity cannot verify publisher or tap-key rotations at this sequence");
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
