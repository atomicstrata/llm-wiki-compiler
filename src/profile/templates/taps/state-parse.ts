/**
 * @file src/profile/templates/taps/state-parse.ts
 * @description Exact-shape parser and caps for authoritative template-tap state.
 */
import { createPublicKey } from "node:crypto";
import { parseBoundedUniqueJson } from "../signing/json.js";
import { parseTemplateCoordinate } from "../signing/protocol.js";
import type { PublisherKey, PublisherPinState } from "../signing/types.js";
import { MAX_TAP_SOURCES, MAX_TAP_STATE_BYTES, MAX_TAP_STATE_ITEMS } from "./capacity.js";
import type { TapOperatorState, TapSourceState } from "./state-types.js";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Parse duplicate-key-free bounded state and reject every unknown field. */
export function parseTapOperatorState(text: string): TapOperatorState {
  const root = record(parseBoundedUniqueJson(text, MAX_TAP_STATE_BYTES), "tap state");
  exact(root, ["schemaVersion", "taps"]);
  if (root.schemaVersion !== 1) throw new Error("tap state schemaVersion must be 1");
  const taps = namedMap(root.taps, "taps", parseSource, MAX_TAP_SOURCES);
  return { schemaVersion: 1, taps };
}

function parseSource(value: unknown, name: string): TapSourceState {
  const obj = record(value, `tap ${name}`);
  exact(obj, ["name", "indexUrl", "origin", "enabled", "currentTapKey", "retiredTapKeyIds", "acceptedIndexDigest", "publisherPins"]);
  if (slug(obj.name, "tap name") !== name) throw new Error("tap state name differs from its map key");
  const indexUrl = httpsUrl(obj.indexUrl, "tap indexUrl");
  const origin = httpsOrigin(obj.origin, "tap origin");
  if (new URL(indexUrl).origin !== origin) throw new Error("tap URL differs from its pinned origin");
  const currentTapKey = publisherKey(obj.currentTapKey);
  const retiredTapKeyIds = stringList(obj.retiredTapKeyIds, "retired tap keys");
  if (retiredTapKeyIds.includes(currentTapKey.keyId)) throw new Error("current tap key cannot be retired");
  const publisherPins = parsePublisherPins(obj.publisherPins, name);
  const acceptedIndexDigest = optionalDigest(obj.acceptedIndexDigest);
  if ((publisherPins.highestSequence < 0) !== (acceptedIndexDigest === null)) {
    throw new Error("accepted index digest differs from continuity sequence state");
  }
  return {
    name,
    indexUrl,
    origin,
    enabled: bool(obj.enabled, "tap enabled"),
    currentTapKey,
    retiredTapKeyIds,
    acceptedIndexDigest,
    publisherPins,
  };
}

function parsePublisherPins(value: unknown, tap: string): PublisherPinState {
  const obj = record(value, "publisher pins");
  exact(obj, ["tap", "highestSequence", "publishers", "keyHistory", "coordinates", "revokedPackages", "revokedPublisherKeys"]);
  if (slug(obj.tap, "pin tap") !== tap) throw new Error("publisher pins belong to another tap");
  const pins: PublisherPinState = {
    tap,
    highestSequence: integer(obj.highestSequence, "highest sequence", -1),
    publishers: namedMap(obj.publishers, "publishers", (item) => publisherKey(item)),
    keyHistory: boundedMap(obj.keyHistory, "key history", parseHistory),
    coordinates: stringMap(obj.coordinates, "coordinates", DIGEST),
    revokedPackages: stringList(obj.revokedPackages, "revoked packages", DIGEST),
    revokedPublisherKeys: stringList(obj.revokedPublisherKeys, "revoked publisher keys"),
  };
  assertPinRelationships(pins, tap);
  return pins;
}

function assertPinRelationships(pins: PublisherPinState, tap: string): void {
  assertActivePublisherPins(pins);
  assertHistoryPublishers(pins);
  assertCoordinateOwners(pins, tap);
}

function assertActivePublisherPins(pins: PublisherPinState): void {
  for (const [publisher, key] of Object.entries(pins.publishers)) {
    const history = pins.keyHistory[key.keyId];
    if (history?.publisher !== publisher || history.publicKey !== key.publicKey) {
      throw new Error(`active publisher key is missing from history: ${publisher}`);
    }
    if (pins.revokedPublisherKeys.includes(key.keyId)) throw new Error(`active publisher key is revoked: ${publisher}`);
  }
}

function assertHistoryPublishers(pins: PublisherPinState): void {
  for (const history of Object.values(pins.keyHistory)) {
    if (!pins.publishers[history.publisher]) throw new Error(`key history names an unknown publisher: ${history.publisher}`);
  }
}

function assertCoordinateOwners(pins: PublisherPinState, tap: string): void {
  for (const coordinate of Object.keys(pins.coordinates)) {
    if (parseTemplateCoordinate(coordinate).tap !== tap) throw new Error(`coordinate belongs to another tap: ${coordinate}`);
  }
}

function parseHistory(value: unknown): { publisher: string; publicKey: string } {
  const obj = record(value, "key history entry");
  exact(obj, ["publisher", "publicKey"]);
  const publicKey = base64(obj.publicKey, "history publicKey");
  assertEd25519(publicKey);
  return { publisher: slug(obj.publisher, "history publisher"), publicKey };
}

function publisherKey(value: unknown): PublisherKey {
  const obj = record(value, "publisher key");
  exact(obj, ["keyId", "publicKey"]);
  const key = { keyId: boundedText(obj.keyId, "key id"), publicKey: base64(obj.publicKey, "public key") };
  assertEd25519(key.publicKey);
  return key;
}

function assertEd25519(publicKey: string): void {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error();
  } catch {
    throw new Error("stored public key is not Ed25519 SPKI DER");
  }
}

function namedMap<T>(value: unknown, label: string, parse: (item: unknown, name: string) => T, cap = MAX_TAP_STATE_ITEMS): Record<string, T> {
  const obj = record(value, label);
  if (Object.keys(obj).length > cap) throw new Error(`${label} exceeds its item cap`);
  return Object.fromEntries(Object.entries(obj).map(([name, item]) => [slug(name, `${label} key`), parse(item, name)]));
}

function stringMap(value: unknown, label: string, pattern?: RegExp): Record<string, string> {
  const obj = record(value, label);
  if (Object.keys(obj).length > MAX_TAP_STATE_ITEMS) throw new Error(`${label} exceeds its item cap`);
  return Object.fromEntries(Object.entries(obj).map(([key, item]) => [boundedText(key, `${label} key`), matched(item, label, pattern)]));
}

function boundedMap<T>(value: unknown, label: string, parse: (item: unknown) => T): Record<string, T> {
  const obj = record(value, label);
  if (Object.keys(obj).length > MAX_TAP_STATE_ITEMS) throw new Error(`${label} exceeds its item cap`);
  return Object.fromEntries(Object.entries(obj).map(([key, item]) => [boundedText(key, `${label} key`), parse(item)]));
}

function stringList(value: unknown, label: string, pattern?: RegExp): string[] {
  if (!Array.isArray(value) || value.length > MAX_TAP_STATE_ITEMS) throw new Error(`${label} must be a bounded array`);
  const values = value.map((item) => matched(item, label, pattern));
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`);
  return values;
}

function matched(value: unknown, label: string, pattern?: RegExp): string {
  const text = boundedText(value, label);
  if (pattern && !pattern.test(text)) throw new Error(`${label} has an invalid value`);
  return text;
}

function optionalDigest(value: unknown): string | null {
  if (value === null) return null;
  return matched(value, "accepted index digest", DIGEST);
}

function httpsUrl(value: unknown, label: string): string {
  const text = boundedText(value, label);
  const url = new URL(text);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(`${label} must be a clean HTTPS URL`);
  return url.toString();
}

function httpsOrigin(value: unknown, label: string): string {
  const text = boundedText(value, label);
  const url = new URL(text);
  if (url.protocol !== "https:" || url.origin !== text) throw new Error(`${label} must be a normalized HTTPS origin`);
  return text;
}

function record(value: unknown, label: string): Record<string, unknown> {
  const isRecord = typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isRecord) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exact(obj: Record<string, unknown>, keys: string[]): void {
  const actual = Object.keys(obj).sort().join("\0");
  const expected = [...keys].sort().join("\0");
  if (actual !== expected) throw new Error("tap state object has unsupported or missing fields");
}

function boundedText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 4096) throw new Error(`${label} must be bounded text`);
  return value;
}

function slug(value: unknown, label: string): string {
  const text = boundedText(value, label);
  if (!SLUG.test(text)) throw new Error(`${label} must be slug-safe`);
  return text;
}

function base64(value: unknown, label: string): string {
  const text = boundedText(value, label);
  const decoded = Buffer.from(text, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== text) throw new Error(`${label} must be base64`);
  return text;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function integer(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${label} must be an integer`);
  return Number(value);
}
