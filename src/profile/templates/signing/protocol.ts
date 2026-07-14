/**
 * @file src/profile/templates/signing/protocol.ts
 * @description Strict bounded parsers for offline signed package and tap-index
 * envelopes. Unknown fields and ambiguous coordinates are rejected.
 */
import type {
  Ed25519Signature,
  PublisherKey,
  PublisherRotation,
  SignedPackageEnvelope,
  SignedTapIndex,
  TapPackageEntry,
  TapRevocation,
  TapKeyRotation,
} from "./types.js";
import { parseBoundedUniqueJson } from "./json.js";

const MAX_SIGNED_PACKAGE_BYTES = 2 * 1024 * 1024;
const MAX_TAP_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_INDEX_ITEMS = 10_000;
const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
const COORDINATE = new RegExp(`^(${SLUG})/(${SLUG})/(${SLUG})@([0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?)$`);

export interface TemplateCoordinate {
  tap: string;
  publisher: string;
  templateId: string;
  version: string;
}

declare const PARSED_TAP_INDEX: unique symbol;
declare const PARSED_SIGNED_PACKAGE: unique symbol;
/** Tap index that passed bounded JSON and complete structural validation. */
export type ParsedTapIndex = SignedTapIndex & { readonly [PARSED_TAP_INDEX]: true };
/** Package envelope that passed bounded JSON and structural validation. */
export type ParsedSignedPackage = SignedPackageEnvelope & { readonly [PARSED_SIGNED_PACKAGE]: true };

/** Parse one unambiguous fully qualified package coordinate. */
export function parseTemplateCoordinate(value: string): TemplateCoordinate {
  const match = COORDINATE.exec(value);
  if (!match) throw new Error(`invalid template coordinate: ${value}`);
  return { tap: match[1], publisher: match[2], templateId: match[3], version: match[4] };
}

/** Parse a signed package envelope from bounded unique-key JSON bytes. */
export function parseSignedPackage(text: string): ParsedSignedPackage {
  const obj = record(parseBoundedUniqueJson(text, MAX_SIGNED_PACKAGE_BYTES), "package envelope");
  exactKeys(obj, ["schemaVersion", "coordinate", "payload", "payloadDigest", "publisherSignature"]);
  equal(obj.schemaVersion, 1, "package schemaVersion must be 1");
  const coordinate = textField(obj.coordinate, "coordinate");
  parseTemplateCoordinate(coordinate);
  return {
    schemaVersion: 1,
    coordinate,
    payload: record(obj.payload, "payload") as unknown as SignedPackageEnvelope["payload"],
    payloadDigest: digest(obj.payloadDigest),
    publisherSignature: signature(obj.publisherSignature),
  } as ParsedSignedPackage;
}

/** Parse a signed tap index from bounded unique-key JSON bytes. */
export function parseSignedTapIndex(text: string): ParsedTapIndex {
  const obj = record(parseBoundedUniqueJson(text, MAX_TAP_INDEX_BYTES), "tap index");
  exactKeys(obj, indexKeys(), ["tapKeyRotation"]);
  equal(obj.schemaVersion, 1, "tap index schemaVersion must be 1");
  const packages = boundedArray(obj.packages, "packages").map(packageEntry);
  rejectDuplicateCoordinates(packages);
  const index: SignedTapIndex = {
    schemaVersion: 1,
    tap: slug(obj.tap, "tap"),
    sequence: natural(obj.sequence, "sequence"),
    generatedAt: timestamp(obj.generatedAt, "generatedAt"),
    expiresAt: timestamp(obj.expiresAt, "expiresAt"),
    publishers: publisherMap(obj.publishers),
    packages,
    rotations: boundedArray(obj.rotations, "rotations").map(rotation),
    ...(obj.tapKeyRotation === undefined ? {} : { tapKeyRotation: tapKeyRotation(obj.tapKeyRotation) }),
    revocations: boundedArray(obj.revocations, "revocations").map(revocation),
    signature: signature(obj.signature),
  };
  validateIndexRelationships(index);
  return index as ParsedTapIndex;
}

function indexKeys(): string[] {
  return ["schemaVersion", "tap", "sequence", "generatedAt", "expiresAt", "publishers", "packages", "rotations", "revocations", "signature", "tapKeyRotation"];
}

function signature(value: unknown): Ed25519Signature {
  const obj = record(value, "signature");
  exactKeys(obj, ["keyId", "algorithm", "value"]);
  equal(obj.algorithm, "ed25519", "signature algorithm must be ed25519");
  return { keyId: textField(obj.keyId, "signature.keyId"), algorithm: "ed25519", value: base64(obj.value, "signature.value") };
}

function publisherKey(value: unknown): PublisherKey {
  const obj = record(value, "publisher key");
  exactKeys(obj, ["keyId", "publicKey"]);
  return { keyId: textField(obj.keyId, "publisher keyId"), publicKey: base64(obj.publicKey, "publisher publicKey") };
}

function publisherMap(value: unknown): Record<string, PublisherKey> {
  const obj = record(value, "publishers");
  if (Object.keys(obj).length > MAX_INDEX_ITEMS) throw new Error("publishers exceeds its item cap");
  return Object.fromEntries(Object.entries(obj).map(([name, key]) => [slug(name, "publisher"), publisherKey(key)]));
}

function packageEntry(value: unknown): TapPackageEntry {
  const obj = record(value, "package entry");
  exactKeys(obj, ["coordinate", "publisher", "payloadDigest"]);
  const coordinate = textField(obj.coordinate, "package coordinate");
  parseTemplateCoordinate(coordinate);
  return { coordinate, publisher: slug(obj.publisher, "package publisher"), payloadDigest: digest(obj.payloadDigest) };
}

function rotation(value: unknown): PublisherRotation {
  const obj = record(value, "publisher rotation");
  exactKeys(obj, ["publisher", "fromKeyId", "toKey", "effectiveSequence", "oldSignature", "newSignature"]);
  return {
    publisher: slug(obj.publisher, "rotation publisher"),
    fromKeyId: textField(obj.fromKeyId, "rotation fromKeyId"),
    toKey: publisherKey(obj.toKey),
    effectiveSequence: natural(obj.effectiveSequence, "rotation effectiveSequence"),
    oldSignature: signature(obj.oldSignature),
    newSignature: signature(obj.newSignature),
  };
}

function tapKeyRotation(value: unknown): TapKeyRotation {
  const obj = record(value, "tap key rotation");
  exactKeys(obj, ["fromKeyId", "toKey", "effectiveSequence", "oldSignature", "newSignature"]);
  return {
    fromKeyId: textField(obj.fromKeyId, "tap rotation fromKeyId"),
    toKey: publisherKey(obj.toKey),
    effectiveSequence: natural(obj.effectiveSequence, "tap rotation effectiveSequence"),
    oldSignature: signature(obj.oldSignature),
    newSignature: signature(obj.newSignature),
  };
}

function revocation(value: unknown): TapRevocation {
  const obj = record(value, "revocation");
  exactKeys(obj, ["kind", "value", "reason", "revokedAt"]);
  if (obj.kind !== "package" && obj.kind !== "publisher-key") throw new Error("revocation kind is invalid");
  return {
    kind: obj.kind,
    value: obj.kind === "package" ? digest(obj.value) : textField(obj.value, "revocation value"),
    reason: textField(obj.reason, "revocation reason"),
    revokedAt: timestamp(obj.revokedAt, "revokedAt"),
  };
}

function rejectDuplicateCoordinates(packages: TapPackageEntry[]): void {
  const seen = new Set<string>();
  for (const entry of packages) {
    if (seen.has(entry.coordinate)) throw new Error(`duplicate package coordinate: ${entry.coordinate}`);
    seen.add(entry.coordinate);
  }
}

function validateIndexRelationships(index: SignedTapIndex): void {
  if (Date.parse(index.generatedAt) >= Date.parse(index.expiresAt)) throw new Error("tap index expiry must follow generation");
  for (const entry of index.packages) {
    const coordinate = parseTemplateCoordinate(entry.coordinate);
    if (coordinate.tap !== index.tap) throw new Error("package coordinate belongs to another tap");
    if (coordinate.publisher !== entry.publisher) throw new Error("package publisher differs from its coordinate");
    if (!(entry.publisher in index.publishers)) throw new Error("package publisher has no declared key");
  }
  assertPublisherKeyIdsUnambiguous(index);
}

function assertPublisherKeyIdsUnambiguous(index: SignedTapIndex): void {
  const owners = new Map<string, string>();
  for (const [publisher, key] of Object.entries(index.publishers)) registerKeyOwner(owners, key.keyId, publisher);
  for (const rotation of index.rotations) {
    registerKeyOwner(owners, rotation.fromKeyId, rotation.publisher);
    registerKeyOwner(owners, rotation.toKey.keyId, rotation.publisher);
  }
}

function registerKeyOwner(owners: Map<string, string>, keyId: string, publisher: string): void {
  const existing = owners.get(keyId);
  if (existing !== undefined && existing !== publisher) throw new Error(`publisher key id is ambiguous: ${keyId}`);
  owners.set(keyId, publisher);
}

function boundedArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > MAX_INDEX_ITEMS) throw new Error(`${label} exceeds its item cap`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(obj: Record<string, unknown>, expected: string[], optional: string[] = []): void {
  const allowed = new Set(expected);
  if (Object.keys(obj).some((key) => !allowed.has(key))) throw new Error("signed object contains unsupported fields");
  if (expected.some((key) => !optional.includes(key) && !(key in obj))) throw new Error("signed object is missing required fields");
}

function textField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 4096) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function slug(value: unknown, label: string): string {
  const text = textField(value, label);
  if (!(new RegExp(`^${SLUG}$`)).test(text)) throw new Error(`${label} must be slug-safe`);
  return text;
}

function digest(value: unknown): string {
  const text = textField(value, "digest");
  sha256DigestHex(text);
  return text;
}

/** Return the path-safe hex component of one canonical SHA-256 digest. */
export function sha256DigestHex(value: string): string {
  const match = /^sha256:([0-9a-f]{64})$/.exec(value);
  if (!match) throw new Error("digest must be prefixed lowercase SHA-256 hex");
  return match[1];
}

function base64(value: unknown, label: string): string {
  const text = textField(value, label);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new Error(`${label} must be base64`);
  if (Buffer.from(text, "base64").toString("base64") !== text) {
    throw new Error(`${label} must be canonical base64`);
  }
  return text;
}

function natural(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return Number(value);
}

function timestamp(value: unknown, label: string): string {
  const text = textField(value, label);
  const parsed = Date.parse(text);
  const normalized = text.includes(".") ? text : text.replace("Z", ".000Z");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text)
    || Number.isNaN(parsed)
    || new Date(parsed).toISOString() !== normalized) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return text;
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(message);
}
