/**
 * @file src/profile/templates/taps/refresh.ts
 * @description Fetch, verify, and atomically accept one signed tap snapshot.
 */
import { TextDecoder } from "node:util";
import { confinedFetch, type ConfinedFetchSeams } from "../../../connectors/confined-fetch.js";
import { canonicalDigest } from "../signing/canonical.js";
import { advancePublisherPins } from "../signing/continuity.js";
import { parseSignedTapIndex } from "../signing/protocol.js";
import type { PublisherKey } from "../signing/types.js";
import { verifyTapIndex, verifyTapKeyRotation } from "../signing/verify.js";
import { writeIndexCache } from "./cache.js";
import { withTapStateLock } from "./operator-lock.js";
import type { TapPaths } from "./paths.js";
import { readTapState, writeTapState } from "./state-store.js";
import type { TapSourceState } from "./state-types.js";

const INDEX_LIMITS = {
  timeoutMs: 15_000,
  maxBytes: 4 * 1024 * 1024,
  maxTransportBytes: 4 * 1024 * 1024,
  maxRedirects: 3,
  contentTypes: ["application/json"],
};

/** Public refresh result without raw keys or index bytes. */
export interface TapRefreshResult { tap: string; sequence: number; packages: number }

/** Refresh one enabled tap and commit continuity only if its snapshot is unchanged. */
export async function refreshTap(paths: TapPaths, name: string, seams: ConfinedFetchSeams = {}): Promise<TapRefreshResult> {
  const initial = (await readTapState(paths)).taps[name];
  if (!initial) throw new Error(`unknown template tap: ${name}`);
  if (!initial.enabled) throw new Error(`template tap is disabled: ${name}`);
  const fetched = await fetchIndex(initial, seams);
  const parsed = parseSignedTapIndex(fetched.text);
  const key = acceptedTapKey(initial, parsed);
  const verified = verifyTapIndex(parsed, name, key);
  const pins = advancePublisherPins(verified, initial.publisherPins);
  const successor = nextSource(initial, key, pins);
  await commitRefresh(paths, initial, successor, fetched.text);
  return { tap: name, sequence: verified.sequence, packages: verified.packages.length };
}

async function fetchIndex(source: TapSourceState, seams: ConfinedFetchSeams): Promise<{ text: string }> {
  const result = await confinedFetch(
    { url: source.indexUrl },
    INDEX_LIMITS,
    { allowedHosts: [new URL(source.indexUrl).hostname], allowedOrigins: [source.origin] },
    seams,
  );
  if (result.kind !== "ok") throw new Error(`tap refresh ${result.kind}: ${result.reason}`);
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(result.bytes) };
  } catch {
    throw new Error("tap index is not valid UTF-8");
  }
}

function acceptedTapKey(source: TapSourceState, index: ReturnType<typeof parseSignedTapIndex>): PublisherKey {
  if (index.signature.keyId === source.currentTapKey.keyId) return source.currentTapKey;
  const rotation = index.tapKeyRotation;
  if (!rotation) throw new Error("tap root changed without a signed rotation");
  if (rotation.effectiveSequence !== index.sequence) throw new Error("tap root rotation sequence differs from its index");
  if (source.retiredTapKeyIds.includes(rotation.toKey.keyId)) throw new Error("retired tap key cannot be reused");
  return verifyTapKeyRotation(source.name, rotation, source.currentTapKey);
}

function nextSource(source: TapSourceState, key: PublisherKey, pins: TapSourceState["publisherPins"]): TapSourceState {
  const rotated = key.keyId !== source.currentTapKey.keyId;
  return {
    ...source,
    currentTapKey: key,
    retiredTapKeyIds: rotated ? [...source.retiredTapKeyIds, source.currentTapKey.keyId] : source.retiredTapKeyIds,
    publisherPins: pins,
  };
}

async function commitRefresh(paths: TapPaths, initial: TapSourceState, next: TapSourceState, indexText: string): Promise<void> {
  await withTapStateLock(paths, async () => {
    const state = await readTapState(paths);
    const current = state.taps[initial.name];
    if (!current || canonicalDigest(current) !== canonicalDigest(initial)) throw new Error("tap state changed during refresh; retry");
    await writeIndexCache(paths, next.name, next.publisherPins.highestSequence, indexText);
    await writeTapState(paths, { ...state, taps: { ...state.taps, [next.name]: next } });
  });
}
