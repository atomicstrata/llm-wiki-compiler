/**
 * @file src/profile/templates/publish/build-verify.ts
 * @description Workspace-aware verification of a freshly built tree.
 *
 * The spec says `build` runs the Slice A verifier before making output visible — but the
 * Slice A verifier REFUSES rotation-bearing indexes by design, because a
 * latest-snapshot-only directory cannot prove continuity. The workspace CAN: it holds the
 * previously pinned keys. So a build verifies as a consumer who has ALREADY PINNED the
 * previous keys, using the production verify/continuity functions — never a weaker copy.
 *
 * A rotation-free build is byte-for-byte the same check a fresh client performs.
 */
import { advancePublisherPins, emptyPublisherPinState } from "../signing/continuity.js";
import { parseSignedPackage, parseSignedTapIndex } from "../signing/protocol.js";
import { verifySignedPackage, verifyTapIndex, verifyTapKeyRotation } from "../signing/verify.js";
import type { PublisherKey, PublisherPinState, SignedTapIndex } from "../signing/types.js";
import type { PublisherWorkspace, WorkspacePackage } from "./workspace-types.js";

/**
 * The pin state a consumer would hold having accepted the workspace's LAST build.
 * Without a real prior state, `advancePublisherPins` would accept any chain from an
 * empty pin set and the rotation walk would prove nothing.
 */
function workspacePinState(workspace: PublisherWorkspace): PublisherPinState {
  const empty = emptyPublisherPinState(workspace.tap);
  if (workspace.sequence === 0) return empty;
  return {
    ...empty,
    highestSequence: workspace.sequence,
    publishers: { [workspace.publisher]: workspace.publisherKey },
    keyHistory: {
      [workspace.publisherKey.keyId]: {
        publisher: workspace.publisher,
        publicKey: workspace.publisherKey.publicKey,
      },
    },
    coordinates: { ...workspace.coordinates },
    revokedPackages: workspace.revocations.filter((r) => r.kind === "package").map((r) => r.value),
    revokedPublisherKeys: workspace.revocations.filter((r) => r.kind === "publisher-key").map((r) => r.value),
  };
}

/**
 * Verify one freshly built index and its envelopes exactly as the consumer would,
 * against the keys a client pinned from the previous build.
 */
export function verifyBuiltDistribution(
  workspace: PublisherWorkspace,
  indexJson: string,
  packages: WorkspacePackage[],
  currentVersion: string,
): SignedTapIndex {
  const parsed = parseSignedTapIndex(indexJson);
  const trustedKey = acceptedTapKey(workspace, parsed);
  const verified = verifyTapIndex(parsed, workspace.tap, trustedKey);
  const pins = advancePublisherPins(verified, workspacePinState(workspace));

  for (const pkg of packages) {
    verifySignedPackage(parseSignedPackage(pkg.envelopeJson), verified, pins, currentVersion);
  }
  return verified;
}

/**
 * Resolve the tap key a client would trust for this index — mirroring
 * `taps/refresh.ts#acceptedTapKey`. A rotating index is trusted under its SUCCESSOR key,
 * proven by a dual-signed rotation from the key the client already pinned.
 */
function acceptedTapKey(
  workspace: PublisherWorkspace,
  index: ReturnType<typeof parseSignedTapIndex>,
): PublisherKey {
  if (index.signature.keyId === workspace.tapKey.keyId) return workspace.tapKey;
  const rotation = index.tapKeyRotation;
  if (!rotation) throw new Error("built index changes the tap root without a signed rotation");
  if (rotation.effectiveSequence !== index.sequence) {
    throw new Error("built tap rotation sequence differs from its index");
  }
  return verifyTapKeyRotation(workspace.tap, rotation, workspace.tapKey);
}
