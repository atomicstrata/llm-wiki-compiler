/**
 * @file src/profile/templates/publish/workspace-types.ts
 * @description Authoritative publisher workspace state.
 *
 * Two invariants are encoded in this shape and must survive every edit:
 *
 * 1. FULL HISTORY IS RETAINED. `followRotationChain` lets a client that skipped
 *    snapshots walk from its pinned key to the current key — but only if every
 *    later index re-emits the historical rotations. So every rotation ever made
 *    survives here and is re-emitted by every build.
 * 2. COORDINATES ARE IMMUTABLE. `coordinates` maps coordinate -> payload digest
 *    forever; the same coordinate may never resolve to different bytes.
 */
import type {
  Ed25519Signature,
  PublisherKey,
  PublisherRotation,
  TapKeyRotation,
  TapRevocation,
} from "../signing/types.js";

/** One package accepted into the workspace, with its publisher signature. */
export interface WorkspacePackage {
  coordinate: string;
  publisher: string;
  payloadDigest: string;
  publisherSignature: Ed25519Signature;
  /** The exact validated envelope bytes emitted into the built tree. */
  envelopeJson: string;
}

/**
 * A rotation or revocation staged for the NEXT build.
 *
 * Rotations cannot be signed when they are created: a rotation claim carries an
 * `effectiveSequence`, and continuity requires it to equal the sequence of the
 * index that publishes it. That sequence is only known at build. So `rotate`
 * generates the successor keypair and stages the intent; `build` signs it at the
 * correct sequence with both keys.
 */
export type PendingIntent =
  | { kind: "rotate-publisher"; fromKeyId: string; toKeyId: string }
  | { kind: "rotate-tap"; fromKeyId: string; toKeyId: string }
  | { kind: "revoke-package"; digest: string; reason: string }
  | { kind: "revoke-publisher-key"; keyId: string; reason: string };

/** The exact identity of the last committed build (spec §4 Slice C). */
export interface LastBuild {
  sequence: number;
  indexDigest: string;
  builtAt: string;
}

/** Authoritative publisher workspace state. */
export interface PublisherWorkspace {
  schemaVersion: 1;
  tap: string;
  publisher: string;
  /** Current signing keys. Successors replace these only after a successful build. */
  tapKey: PublisherKey;
  publisherKey: PublisherKey;
  /** Sequence of the last COMMITTED build; the next build uses this + 1. */
  sequence: number;
  packages: WorkspacePackage[];
  /** Retained history — re-emitted in every index. */
  rotations: PublisherRotation[];
  tapKeyRotations: TapKeyRotation[];
  revocations: TapRevocation[];
  pending: PendingIntent[];
  /** Coordinate -> payload digest, forever. */
  coordinates: Record<string, string>;
  lastBuild?: LastBuild;
}
