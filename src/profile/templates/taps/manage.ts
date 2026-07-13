/**
 * @file src/profile/templates/taps/manage.ts
 * @description Add, disable, re-enable, and list explicitly trusted taps.
 */
import { createHash, createPublicKey } from "node:crypto";
import { MAX_CONNECTOR_URL_BYTES } from "../../../connectors/confined-fetch.js";
import { emptyPublisherPinState } from "../signing/continuity.js";
import type { PublisherKey } from "../signing/types.js";
import { tapStateCapacityWarnings } from "./capacity.js";
import type { TapPaths } from "./paths.js";
import { withTapStateLock } from "./operator-lock.js";
import { readTapState, writeTapState } from "./state-store.js";
import type { TapSourceState } from "./state-types.js";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Public tap metadata suitable for human and JSON output. */
export interface TapSummary {
  name: string;
  indexUrl: string;
  origin: string;
  enabled: boolean;
  keyId: string;
  keyFingerprint: string;
  highestSequence: number;
  warnings: string[];
}

/** Add a fresh tap or re-enable its exact retained trust identity. */
export async function addTap(paths: TapPaths, input: { name: string; indexUrl: string; key: PublisherKey }): Promise<TapSummary> {
  const source = newTapSource(input);
  return withTapStateLock(paths, async () => {
    const state = await readTapState(paths);
    const existing = state.taps[source.name];
    if (existing) assertSameRetainedTap(existing, source);
    const next = existing ? { ...existing, enabled: true } : source;
    await writeTapState(paths, { ...state, taps: { ...state.taps, [next.name]: next } });
    return summarize(next);
  });
}

/** Disable a tap while retaining every root, pin, revocation, and coordinate. */
export async function removeTap(paths: TapPaths, name: string): Promise<TapSummary> {
  assertSlug(name, "tap name");
  return withTapStateLock(paths, async () => {
    const state = await readTapState(paths);
    const existing = state.taps[name];
    if (!existing) throw new Error(`unknown template tap: ${name}`);
    const next = { ...existing, enabled: false };
    await writeTapState(paths, { ...state, taps: { ...state.taps, [name]: next } });
    return summarize(next);
  });
}

/** Permanently delete one tap's roots and continuity after explicit consent. */
export async function forgetTap(paths: TapPaths, name: string, confirmed: boolean): Promise<void> {
  assertSlug(name, "tap name");
  if (!confirmed) throw new Error("tap forget requires --yes because it permanently deletes trust history");
  await withTapStateLock(paths, async () => {
    const state = await readTapState(paths);
    if (!state.taps[name]) throw new Error(`unknown template tap: ${name}`);
    const taps = { ...state.taps };
    delete taps[name];
    await writeTapState(paths, { ...state, taps });
  });
}

/** List configured taps without exposing raw key bytes. */
export async function listTaps(paths: TapPaths): Promise<TapSummary[]> {
  const state = await readTapState(paths);
  const warnings = tapStateCapacityWarnings(state);
  return Object.values(state.taps).map((source) => summarize(source, warnings.filter((item) => item.startsWith(source.name) || item.startsWith("operator "))))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function newTapSource(input: { name: string; indexUrl: string; key: PublisherKey }): TapSourceState {
  assertSlug(input.name, "tap name");
  const url = parseIndexUrl(input.indexUrl);
  assertPublicKey(input.key);
  return {
    name: input.name,
    indexUrl: url.toString(),
    origin: url.origin,
    enabled: true,
    currentTapKey: input.key,
    retiredTapKeyIds: [],
    publisherPins: emptyPublisherPinState(input.name),
  };
}

function parseIndexUrl(value: string): URL {
  if (Buffer.byteLength(value) > MAX_CONNECTOR_URL_BYTES) throw new Error("tap index URL exceeds its byte cap");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("tap index URL must be clean HTTPS");
  if (!url.pathname.endsWith("/index.json")) throw new Error("tap index URL must end in /index.json");
  if (Buffer.byteLength(url.toString()) > MAX_CONNECTOR_URL_BYTES) throw new Error("tap index URL exceeds its byte cap");
  return url;
}

function assertPublicKey(key: PublisherKey): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key.keyId) || Buffer.byteLength(key.publicKey) > 4096) throw new Error("tap key id or value is invalid");
  try {
    const parsed = createPublicKey({ key: Buffer.from(key.publicKey, "base64"), format: "der", type: "spki" });
    if (parsed.asymmetricKeyType !== "ed25519") throw new Error();
  } catch {
    throw new Error("tap public key must be Ed25519 SPKI DER in base64");
  }
}

function assertSameRetainedTap(existing: TapSourceState, proposed: TapSourceState): void {
  const same = existing.indexUrl === proposed.indexUrl
    && existing.origin === proposed.origin
    && existing.currentTapKey.keyId === proposed.currentTapKey.keyId
    && existing.currentTapKey.publicKey === proposed.currentTapKey.publicKey;
  if (!same) throw new Error("tap trust identity cannot be replaced; use a new tap name");
}

function summarize(source: TapSourceState, warnings: string[] = []): TapSummary {
  return {
    name: source.name,
    indexUrl: source.indexUrl,
    origin: source.origin,
    enabled: source.enabled,
    keyId: source.currentTapKey.keyId,
    keyFingerprint: createHash("sha256").update(Buffer.from(source.currentTapKey.publicKey, "base64")).digest("hex"),
    highestSequence: source.publisherPins.highestSequence,
    warnings,
  };
}

function assertSlug(value: string, label: string): void {
  if (!SLUG.test(value)) throw new Error(`${label} must be slug-safe`);
}
