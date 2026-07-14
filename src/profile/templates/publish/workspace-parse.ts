/**
 * @file src/profile/templates/publish/workspace-parse.ts
 * @description Bounded, fail-closed parsing of authoritative workspace state.
 * Mirrors the tap operator-state discipline: duplicate-key rejection, byte and
 * item caps, exact-key rejection of unknown fields. The workspace holds signing
 * identity, so a permissive parser here is a signing-identity confusion bug.
 */
import { isSlugSafe } from "../../identity.js";
import { parseBoundedUniqueJson } from "../signing/json.js";
import { parseTemplateCoordinate, sha256DigestHex } from "../signing/protocol.js";
import type { PublisherWorkspace } from "./workspace-types.js";

export const MAX_WORKSPACE_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS = 10_000;

/** Parse and validate authoritative workspace state from its stored bytes. */
export function parsePublisherWorkspace(text: string): PublisherWorkspace {
  const root = record(parseBoundedUniqueJson(text, MAX_WORKSPACE_BYTES), "workspace");
  exactKeys(root, [
    "schemaVersion", "tap", "publisher", "tapKey", "publisherKey", "sequence",
    "packages", "rotations", "tapKeyRotations", "revocations", "pending",
    "coordinates", "lastBuild",
  ]);
  if (root.schemaVersion !== 1) throw new Error("workspace schemaVersion must be 1");
  const workspace: PublisherWorkspace = {
    schemaVersion: 1,
    tap: slug(root.tap, "workspace tap"),
    publisher: slug(root.publisher, "workspace publisher"),
    tapKey: publisherKey(root.tapKey, "workspace tap key"),
    publisherKey: publisherKey(root.publisherKey, "workspace publisher key"),
    sequence: naturalNumber(root.sequence, "workspace sequence"),
    packages: boundedArray(root.packages, "workspace packages") as PublisherWorkspace["packages"],
    rotations: boundedArray(root.rotations, "workspace rotations") as PublisherWorkspace["rotations"],
    tapKeyRotations: boundedArray(root.tapKeyRotations, "workspace tap rotations") as PublisherWorkspace["tapKeyRotations"],
    revocations: boundedArray(root.revocations, "workspace revocations") as PublisherWorkspace["revocations"],
    pending: boundedArray(root.pending, "workspace pending") as PublisherWorkspace["pending"],
    coordinates: coordinateMap(root.coordinates),
    ...(root.lastBuild === undefined ? {} : { lastBuild: root.lastBuild as PublisherWorkspace["lastBuild"] }),
  };
  return workspace;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(obj: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new Error(`workspace has an unexpected field: ${key}`);
  }
}

function slug(value: unknown, label: string): string {
  if (typeof value !== "string" || !isSlugSafe(value)) throw new Error(`${label} must be slug-safe`);
  return value;
}

function publisherKey(value: unknown, label: string): PublisherWorkspace["tapKey"] {
  const obj = record(value, label);
  exactKeysOf(obj, ["keyId", "publicKey"], label);
  if (typeof obj.keyId !== "string" || obj.keyId.length === 0) throw new Error(`${label} keyId must be a non-empty string`);
  if (typeof obj.publicKey !== "string" || obj.publicKey.length === 0) throw new Error(`${label} publicKey must be a non-empty string`);
  return { keyId: obj.keyId, publicKey: obj.publicKey };
}

function exactKeysOf(obj: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new Error(`${label} has an unexpected field: ${key}`);
  }
}

function naturalNumber(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

function boundedArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error(`${label} must be a bounded array`);
  return value;
}

/**
 * Every key is validated by the production coordinate parser, so a hostile manifest
 * cannot smuggle a non-coordinate key (`__proto__`, a traversal string) into the map
 * that `add` consults for coordinate immutability.
 */
function coordinateMap(value: unknown): Record<string, string> {
  const obj = record(value, "workspace coordinates");
  if (Object.keys(obj).length > MAX_ITEMS) throw new Error("workspace coordinates exceeds its item cap");
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [coordinate, digest] of Object.entries(obj)) {
    if (typeof digest !== "string") throw new Error("workspace coordinate digest must be a string");
    parseTemplateCoordinate(coordinate);
    sha256DigestHex(digest);
    result[coordinate] = digest;
  }
  return { ...result };
}
