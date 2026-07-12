/**
 * @file src/profile/templates/taps/evidence.ts
 * @description Re-verification of the authoritative tap's accepted cached index.
 */
import { parseSignedTapIndex } from "../signing/protocol.js";
import { verifyAcceptedTapIndex, type VerifiedTapIndex } from "../signing/verify.js";
import { readIndexCache } from "./cache.js";
import type { TapPaths } from "./paths.js";
import type { TapSourceState } from "./state-types.js";

/** Load and cryptographically re-verify the exact sequence accepted in state. */
export async function loadAcceptedIndex(paths: TapPaths, source: TapSourceState): Promise<VerifiedTapIndex> {
  if (source.publisherPins.highestSequence < 0) throw new Error(`template tap has not been refreshed: ${source.name}`);
  const text = await readIndexCache(paths, source.name, source.publisherPins.highestSequence);
  const parsed = parseSignedTapIndex(text);
  const verified = verifyAcceptedTapIndex(parsed, source.name, source.currentTapKey, source.publisherPins);
  assertContinuityMatchesIndex(verified, source);
  return verified;
}

function assertContinuityMatchesIndex(index: VerifiedTapIndex, source: TapSourceState): void {
  for (const [publisher, announced] of Object.entries(index.publishers)) {
    const pinned = source.publisherPins.publishers[publisher];
    if (pinned?.keyId !== announced.keyId || pinned.publicKey !== announced.publicKey) {
      throw new Error(`template tap publisher continuity does not match accepted index: ${publisher}`);
    }
  }
  for (const entry of index.packages) {
    if (source.publisherPins.coordinates[entry.coordinate] !== entry.payloadDigest) {
      throw new Error(`template tap coordinate continuity does not match accepted index: ${entry.coordinate}`);
    }
  }
}
