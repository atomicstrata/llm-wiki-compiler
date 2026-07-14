/**
 * @file src/profile/templates/publish/index-builder.ts
 * @description Assemble and sign one tap index.
 *
 * Three rules are load-bearing; each was derived from the consumer, not invented here:
 *
 * 1. RETAINED HISTORY. `followRotationChain` lets a client that skipped snapshots walk
 *    from its pinned key to the current key — but only from the LATEST index. So every
 *    historical rotation and revocation is re-emitted in every index, forever.
 * 2. A TAP-ROTATING INDEX IS SIGNED BY THE SUCCESSOR KEY. `taps/refresh.ts#acceptedTapKey`
 *    resolves the trusted key for a rotating index to `rotation.toKey` and only THEN
 *    checks the index signature against it. Signing such an index with the old key
 *    produces an index no client can accept.
 * 3. REVOKED PACKAGES ARE EXCLUDED. `verifySignedPackage` calls `assertEvidenceNotRevoked`,
 *    so an index that both lists and emits a revoked package is one no verifier — including
 *    our own build gate — will accept.
 */
import { tapIndexClaim } from "../signing/canonical.js";
import { parseSignedTapIndex } from "../signing/protocol.js";
import { signClaim, type PrivateSigningKey } from "../signing/sign.js";
import type {
  PublisherKey,
  PublisherRotation,
  SignedTapIndex,
  TapKeyRotation,
  TapPackageEntry,
  TapRevocation,
} from "../signing/types.js";
import type { PublisherWorkspace, WorkspacePackage } from "./workspace-types.js";

/** Everything a build has resolved by the time the index can be assembled. */
export interface IndexBuildInput {
  sequence: number;
  generatedAt: Date;
  expiresAt: Date;
  /** Publisher key announced by this index (the successor when rotating). */
  publisherKey: PublisherKey;
  /** Tap key announced by this index (the successor when rotating). */
  tapKey: PublisherKey;
  /** The key that SIGNS this index — the successor whenever a tap rotation is present. */
  signingKey: PrivateSigningKey;
  /** Rotations signed at THIS sequence, appended to retained history. */
  newRotations: PublisherRotation[];
  newTapRotation?: TapKeyRotation;
  /** Revocations created at THIS sequence, appended to retained history. */
  newRevocations: TapRevocation[];
  /** Envelopes to publish; already filtered of revoked digests by the caller. */
  packages: WorkspacePackage[];
}

/** One assembled, signed index plus the exact bytes to write. */
export interface BuiltIndex {
  index: SignedTapIndex;
  indexJson: string;
  rotations: PublisherRotation[];
  tapKeyRotations: TapKeyRotation[];
  revocations: TapRevocation[];
}

/** Assemble and sign one index, proving it parses before it is returned. */
export function buildSignedIndex(workspace: PublisherWorkspace, input: IndexBuildInput): BuiltIndex {
  const rotations = [...workspace.rotations, ...input.newRotations];
  const tapKeyRotations = [
    ...workspace.tapKeyRotations,
    ...(input.newTapRotation === undefined ? [] : [input.newTapRotation]),
  ];
  const revocations = [...workspace.revocations, ...input.newRevocations];

  const unsigned = {
    schemaVersion: 1 as const,
    tap: workspace.tap,
    sequence: input.sequence,
    generatedAt: input.generatedAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
    publishers: { [workspace.publisher]: input.publisherKey },
    packages: input.packages.map(packageEntry),
    rotations,
    // Only the rotation taking effect AT this sequence may ride in the index; the
    // parser accepts a single `tapKeyRotation`, and the consumer requires its
    // effectiveSequence to equal this index's sequence.
    ...(input.newTapRotation === undefined ? {} : { tapKeyRotation: input.newTapRotation }),
    revocations,
  };

  const signature = signClaim(tapIndexClaim(unsigned), input.signingKey);
  const index = { ...unsigned, signature } as SignedTapIndex;
  const indexJson = JSON.stringify(index);
  parseSignedTapIndex(indexJson);
  return { index, indexJson, rotations, tapKeyRotations, revocations };
}

function packageEntry(pkg: WorkspacePackage): TapPackageEntry {
  return { coordinate: pkg.coordinate, publisher: pkg.publisher, payloadDigest: pkg.payloadDigest };
}
