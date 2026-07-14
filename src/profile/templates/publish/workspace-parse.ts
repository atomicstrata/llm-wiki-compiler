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
    "coordinates", "lastBuild", "reservedSequence",
  ]);
  if (root.schemaVersion !== 1) throw new Error("workspace schemaVersion must be 1");
  const workspace: PublisherWorkspace = {
    schemaVersion: 1,
    tap: slug(root.tap, "workspace tap"),
    publisher: slug(root.publisher, "workspace publisher"),
    tapKey: publisherKey(root.tapKey, "workspace tap key"),
    publisherKey: publisherKey(root.publisherKey, "workspace publisher key"),
    sequence: naturalNumber(root.sequence, "workspace sequence"),
    packages: boundedArray(root.packages, "workspace packages").map(workspacePackage),
    rotations: boundedArray(root.rotations, "workspace rotations").map(publisherRotation),
    tapKeyRotations: boundedArray(root.tapKeyRotations, "workspace tap rotations").map(tapKeyRotation),
    revocations: boundedArray(root.revocations, "workspace revocations").map(revocation),
    pending: boundedArray(root.pending, "workspace pending").map(pendingIntent),
    coordinates: coordinateMap(root.coordinates),
    ...(root.lastBuild === undefined ? {} : { lastBuild: lastBuild(root.lastBuild) }),
    ...(root.reservedSequence === undefined
      ? {}
      : { reservedSequence: naturalNumber(root.reservedSequence, "workspace reservedSequence") }),
  };
  return workspace;
}

/** The last build's recorded identity, validated rather than cast (audit LOW finding). */
function lastBuild(value: unknown): PublisherWorkspace["lastBuild"] {
  const obj = record(value, "workspace lastBuild");
  exactKeysOf(obj, ["sequence", "indexDigest", "builtAt", "contentDigest"], "workspace lastBuild");
  return {
    sequence: naturalNumber(obj.sequence, "lastBuild sequence"),
    indexDigest: digest(obj.indexDigest, "lastBuild indexDigest"),
    builtAt: nonEmptyText(obj.builtAt, "lastBuild builtAt"),
    contentDigest: digest(obj.contentDigest, "lastBuild contentDigest"),
  };
}

function digest(value: unknown, label: string): string {
  const text = nonEmptyText(value, label);
  sha256DigestHex(text);
  return text;
}

function nonEmptyText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

/**
 * Every nested element is parsed, not cast. The workspace carries SIGNING IDENTITY: a
 * permissive parser here is a signing-identity confusion bug, and a cast is not a parse.
 */
function workspacePackage(value: unknown): PublisherWorkspace["packages"][number] {
  const obj = record(value, "workspace package");
  exactKeysOf(obj, ["coordinate", "publisher", "payloadDigest", "publisherSignature", "envelopeJson"], "workspace package");
  parseTemplateCoordinate(nonEmptyText(obj.coordinate, "package coordinate"));
  return {
    coordinate: obj.coordinate as string,
    publisher: slug(obj.publisher, "package publisher"),
    payloadDigest: digest(obj.payloadDigest, "package payloadDigest"),
    publisherSignature: signature(obj.publisherSignature, "package signature"),
    envelopeJson: nonEmptyText(obj.envelopeJson, "package envelopeJson"),
  };
}

function signature(value: unknown, label: string): PublisherWorkspace["packages"][number]["publisherSignature"] {
  const obj = record(value, label);
  exactKeysOf(obj, ["keyId", "algorithm", "value"], label);
  if (obj.algorithm !== "ed25519") throw new Error(`${label} algorithm must be ed25519`);
  return {
    keyId: nonEmptyText(obj.keyId, `${label} keyId`),
    algorithm: "ed25519",
    value: nonEmptyText(obj.value, `${label} value`),
  };
}

function keyOf(value: unknown, label: string): PublisherWorkspace["tapKey"] {
  return publisherKey(value, label);
}

function publisherRotation(value: unknown): PublisherWorkspace["rotations"][number] {
  const obj = record(value, "workspace rotation");
  exactKeysOf(obj, ["publisher", "fromKeyId", "toKey", "effectiveSequence", "oldSignature", "newSignature"], "workspace rotation");
  return {
    publisher: slug(obj.publisher, "rotation publisher"),
    fromKeyId: nonEmptyText(obj.fromKeyId, "rotation fromKeyId"),
    toKey: keyOf(obj.toKey, "rotation toKey"),
    effectiveSequence: naturalNumber(obj.effectiveSequence, "rotation effectiveSequence"),
    oldSignature: signature(obj.oldSignature, "rotation oldSignature"),
    newSignature: signature(obj.newSignature, "rotation newSignature"),
  };
}

function tapKeyRotation(value: unknown): PublisherWorkspace["tapKeyRotations"][number] {
  const obj = record(value, "workspace tap rotation");
  exactKeysOf(obj, ["fromKeyId", "toKey", "effectiveSequence", "oldSignature", "newSignature"], "workspace tap rotation");
  return {
    fromKeyId: nonEmptyText(obj.fromKeyId, "tap rotation fromKeyId"),
    toKey: keyOf(obj.toKey, "tap rotation toKey"),
    effectiveSequence: naturalNumber(obj.effectiveSequence, "tap rotation effectiveSequence"),
    oldSignature: signature(obj.oldSignature, "tap rotation oldSignature"),
    newSignature: signature(obj.newSignature, "tap rotation newSignature"),
  };
}

function revocation(value: unknown): PublisherWorkspace["revocations"][number] {
  const obj = record(value, "workspace revocation");
  exactKeysOf(obj, ["kind", "value", "reason", "revokedAt"], "workspace revocation");
  if (obj.kind !== "package" && obj.kind !== "publisher-key") {
    throw new Error("revocation kind must be package or publisher-key");
  }
  return {
    kind: obj.kind,
    value: nonEmptyText(obj.value, "revocation value"),
    reason: nonEmptyText(obj.reason, "revocation reason"),
    revokedAt: nonEmptyText(obj.revokedAt, "revocation revokedAt"),
  };
}

function pendingIntent(value: unknown): PublisherWorkspace["pending"][number] {
  const obj = record(value, "workspace pending intent");
  const kind = obj.kind;
  if (kind === "rotate-publisher" || kind === "rotate-tap") {
    exactKeysOf(obj, ["kind", "fromKeyId", "toKeyId"], "pending rotation");
    return {
      kind,
      fromKeyId: nonEmptyText(obj.fromKeyId, "pending fromKeyId"),
      toKeyId: nonEmptyText(obj.toKeyId, "pending toKeyId"),
    };
  }
  if (kind === "revoke-package") {
    exactKeysOf(obj, ["kind", "digest", "reason"], "pending revocation");
    return { kind, digest: digest(obj.digest, "pending digest"), reason: nonEmptyText(obj.reason, "pending reason") };
  }
  if (kind === "revoke-publisher-key") {
    exactKeysOf(obj, ["kind", "keyId", "reason"], "pending revocation");
    return { kind, keyId: nonEmptyText(obj.keyId, "pending keyId"), reason: nonEmptyText(obj.reason, "pending reason") };
  }
  throw new Error("pending intent kind is unknown");
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
