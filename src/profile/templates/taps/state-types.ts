/**
 * @file src/profile/templates/taps/state-types.ts
 * @description Authoritative bounded operator state for configured template taps.
 */
import type { PublisherKey, PublisherPinState } from "../signing/types.js";

/** One configured source and all continuity needed to prevent trust resets. */
export interface TapSourceState {
  name: string;
  indexUrl: string;
  origin: string;
  enabled: boolean;
  currentTapKey: PublisherKey;
  retiredTapKeyIds: string[];
  acceptedIndexDigest: string | null;
  publisherPins: PublisherPinState;
}

/** Versioned global tap state; cache files are never authoritative substitutes. */
export interface TapOperatorState {
  schemaVersion: 1;
  taps: Record<string, TapSourceState>;
}

/** Empty state for an operator who has configured no taps. */
export function emptyTapOperatorState(): TapOperatorState {
  return { schemaVersion: 1, taps: {} };
}
