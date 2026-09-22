/**
 * @file src/capability-providers/ids.ts
 * @description Bounded parsers that exclusively mint Provider V2 coordinate,
 * digest, version, and path-facing logical-identity brands. Refusals expose
 * only host-authored labels and bounded classifications, never rejected bytes.
 */
import { types as utilTypes } from "node:util";
import {
  MAX_CAPABILITY_CONTRACT_VERSION_BYTES,
  MAX_PROVIDER_COORDINATE_BYTES,
  MAX_PROVIDER_COORDINATE_COMPONENT_BYTES,
  MAX_PROVIDER_LOGICAL_ID_BYTES,
  MAX_PROVIDER_LOGICAL_ID_SNAPSHOT_ITEMS,
  MAX_PROVIDER_SEMANTIC_VERSION_BYTES,
} from "./constants.js";
import { WINDOWS_RESERVED_DEVICE_NAMES } from "../utils/windows-reserved-names.js";
import type {
  BackendIdV1,
  BrokerIdV1,
  CapabilityIdV1,
  CapabilityContractVersionV1,
  EffectIdV1,
  InputIdV1,
  InvocationIdV1,
  ParsedProviderCoordinateV1,
  ProviderCoordinateComponentV1,
  ProviderCoordinateV1,
  ProviderIdV1,
  ProviderLogicalIdV1,
  ReceiptIdV1,
  RequestIdV1,
  SemanticVersionV1,
  Sha256Digest,
} from "./types.js";

const SLUG_SOURCE = "[a-z0-9]+(?:-[a-z0-9]+)*";
const NUMERIC_IDENTIFIER = "(?:0|[1-9][0-9]*)";
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const BUILD_IDENTIFIER = "[0-9A-Za-z-]+";
const SEMVER_SOURCE = `${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}`
  + `(?:-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?`
  + `(?:\\+${BUILD_IDENTIFIER}(?:\\.${BUILD_IDENTIFIER})*)?`;
const SEMANTIC_VERSION = new RegExp(`^${SEMVER_SOURCE}$`);
const LOGICAL_ID = new RegExp(`^${SLUG_SOURCE}$`);
const REQUEST_TOKEN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA256_DIGEST_CODE_UNITS = 71;
const WINDOWS_DEVICE_BASENAMES = new Set(WINDOWS_RESERVED_DEVICE_NAMES);

/** Parse one unambiguous coordinate with exact branded parts. */
export function parseProviderCoordinate(value: unknown): ParsedProviderCoordinateV1 {
  const coordinate = boundedString(value, "provider coordinate", MAX_PROVIDER_COORDINATE_BYTES);
  const [tapText, publisherText, providerText, versionText] = coordinateParts(coordinate);
  const tap = coordinateComponent(tapText, "tap");
  const publisher = coordinateComponent(publisherText, "publisher");
  const provider = coordinateComponent(providerText, "provider");
  const providerVersion = semanticVersion(versionText, "provider coordinate semantic version");
  return Object.freeze({
    coordinate: coordinate as ProviderCoordinateV1,
    tap,
    publisher,
    providerId: provider as unknown as ProviderIdV1,
    providerVersion,
  });
}

/** Parse a canonical lowercase SHA-256 digest string. */
export function parseSha256Digest(value: unknown): Sha256Digest {
  const digest = stringValue(value, "SHA-256 digest");
  if (digest.length !== SHA256_DIGEST_CODE_UNITS || !SHA256_DIGEST.test(digest)) {
    throw invalidString("SHA-256 digest", "does not match canonical grammar");
  }
  return digest as Sha256Digest;
}

/** Parse one exact SemVer 2.0.0 version, never a range or moving tag. */
export function parseSemanticVersion(value: unknown): SemanticVersionV1 {
  const version = boundedString(value, "semantic version", MAX_PROVIDER_SEMANTIC_VERSION_BYTES);
  return semanticVersion(version, "semantic version");
}

/** Parse one exact opaque capability contract version without normalization. */
export function parseCapabilityContractVersion(value: unknown): CapabilityContractVersionV1 {
  const label = "capability contract version";
  const version = boundedString(value, label, MAX_CAPABILITY_CONTRACT_VERSION_BYTES);
  if (version.length === 0) throw invalidString(label, "must be nonempty");
  return version as CapabilityContractVersionV1;
}

/** Parse a provider ID safe for exact comparison and path-facing use. */
export function parseProviderId(value: unknown): ProviderIdV1 {
  return logicalId<ProviderIdV1>(value, "provider");
}

/** Parse a capability ID safe for exact comparison and path-facing use. */
export function parseCapabilityId(value: unknown): CapabilityIdV1 {
  return logicalId<CapabilityIdV1>(value, "capability");
}

/** Parse a host-registered broker ID. */
export function parseBrokerId(value: unknown): BrokerIdV1 {
  return logicalId<BrokerIdV1>(value, "broker");
}

/** Parse one provider-visible materialized input ID. */
export function parseInputId(value: unknown): InputIdV1 {
  return logicalId<InputIdV1>(value, "input");
}

/** Parse a host-minted invocation ID. */
export function parseInvocationId(value: unknown): InvocationIdV1 {
  return logicalId<InvocationIdV1>(value, "invocation");
}

/** Parse a request ID used by the framed protocol. */
export function parseRequestId(value: unknown): RequestIdV1 {
  const label = "request ID";
  const identity = boundedString(value, label, MAX_PROVIDER_LOGICAL_ID_BYTES);
  validateRequestTokenGrammar(identity, label);
  return identity as RequestIdV1;
}

/** Parse a host-derived external effect ID. */
export function parseEffectId(value: unknown): EffectIdV1 {
  return logicalId<EffectIdV1>(value, "effect");
}

/** Parse an immutable host receipt ID. */
export function parseReceiptId(value: unknown): ReceiptIdV1 {
  return logicalId<ReceiptIdV1>(value, "receipt");
}

/** Parse a registered sandbox backend ID. */
export function parseBackendId(value: unknown): BackendIdV1 {
  return logicalId<BackendIdV1>(value, "backend");
}

/** Return the frozen validated identity snapshot safe for record assembly. */
export function snapshotUniqueLogicalIds(
  values: readonly ProviderLogicalIdV1[],
  maximumItems: number,
): readonly ProviderLogicalIdV1[] {
  const snapshot = captureLogicalIdSnapshot(values, maximumItems);
  const seen = new Set<string>();
  for (let index = 0; index < snapshot.length; index += 1) {
    const value = snapshot[index];
    const validated = validatedProviderLogicalId(value);
    if (seen.has(validated)) {
      throw invalidString("provider logical ID", "is duplicated");
    }
    seen.add(validated);
  }
  return Object.freeze(snapshot);
}

function captureLogicalIdSnapshot(
  values: readonly ProviderLogicalIdV1[],
  maximumItems: number,
): ProviderLogicalIdV1[] {
  validateSnapshotMaximum(maximumItems);
  if (utilTypes.isProxy(values) || !Array.isArray(values)) throw invalidSnapshot();
  const length = values.length;
  if (length > maximumItems) throw invalidSnapshot();
  const snapshot: ProviderLogicalIdV1[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(values, index);
    if (descriptor === undefined || !("value" in descriptor)) throw invalidSnapshot();
    snapshot.push(values[index]);
  }
  return snapshot;
}

function validateSnapshotMaximum(maximumItems: number): void {
  if (
    typeof maximumItems !== "number"
    || !Number.isSafeInteger(maximumItems)
    || maximumItems < 0
    || maximumItems > MAX_PROVIDER_LOGICAL_ID_SNAPSHOT_ITEMS
  ) throw invalidSnapshot();
}

function invalidSnapshot(): Error {
  return new Error("invalid provider logical ID snapshot");
}

function coordinateParts(coordinate: string): readonly [string, string, string, string] {
  const pathParts = coordinate.split("/");
  const providerVersion = pathParts[2] ?? "";
  const separator = providerVersion.indexOf("@");
  const hasOneSeparator = separator > 0 && separator === providerVersion.lastIndexOf("@");
  if (pathParts.length !== 3 || !hasOneSeparator || separator === providerVersion.length - 1) {
    throw invalidString("provider coordinate", "does not match required structure");
  }
  return [pathParts[0], pathParts[1], providerVersion.slice(0, separator), providerVersion.slice(separator + 1)];
}

function coordinateComponent(value: string, kind: string): ProviderCoordinateComponentV1 {
  const label = `provider coordinate ${kind} component`;
  const component = boundedString(value, label, MAX_PROVIDER_COORDINATE_COMPONENT_BYTES);
  validatePathFacingGrammar(component, label);
  return component as ProviderCoordinateComponentV1;
}

function semanticVersion(value: string, label: string): SemanticVersionV1 {
  const version = boundedString(value, label, MAX_PROVIDER_SEMANTIC_VERSION_BYTES);
  if (!SEMANTIC_VERSION.test(version)) {
    throw invalidString(label, "does not match required grammar");
  }
  return version as SemanticVersionV1;
}

function logicalId<Identity extends string>(value: unknown, kind: string): Identity {
  const label = `${kind} ID`;
  return validatedLogicalId(value, label) as Identity;
}

function validatedLogicalId(value: unknown, label: string): string {
  const identity = boundedString(value, label, MAX_PROVIDER_LOGICAL_ID_BYTES);
  validatePathFacingGrammar(identity, label);
  return identity;
}

function validatedProviderLogicalId(value: unknown): string {
  const label = "provider logical ID";
  const identity = boundedString(value, label, MAX_PROVIDER_LOGICAL_ID_BYTES);
  if (!LOGICAL_ID.test(identity) && !REQUEST_TOKEN.test(identity)) {
    throw invalidString(label, "does not match required grammar");
  }
  rejectWindowsDevice(identity, label);
  return identity;
}

function validatePathFacingGrammar(value: string, label: string): void {
  if (!LOGICAL_ID.test(value)) {
    throw invalidString(label, "does not match required grammar");
  }
  rejectWindowsDevice(value, label);
}

function validateRequestTokenGrammar(value: string, label: string): void {
  if (!REQUEST_TOKEN.test(value)) {
    throw invalidString(label, "does not match required grammar");
  }
  rejectWindowsDevice(value, label);
}

function rejectWindowsDevice(value: string, label: string): void {
  if (WINDOWS_DEVICE_BASENAMES.has(value)) {
    throw invalidString(label, "is a reserved Windows device basename");
  }
}

function boundedString(value: unknown, label: string, maximumBytes: number): string {
  const text = stringValue(value, label);
  if (text.length > maximumBytes) {
    throw invalidString(label, `exceeds ${maximumBytes} UTF-8 bytes`);
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maximumBytes) {
    throw invalidString(label, `exceeds ${maximumBytes} UTF-8 bytes`);
  }
  return text;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") {
    const received = value === null ? "null" : typeof value;
    throw new Error(`invalid ${label}: expected string; received ${received}`);
  }
  return value;
}

function invalidString(label: string, reason: string): Error {
  return new Error(`invalid ${label}: ${reason}`);
}

/** Production-compiled, zero-runtime uniqueness signature assertions. */
type GuardAssignable<Source, Target> = [Source] extends [Target] ? true : false;
type GuardAssertFalse<Value extends false> = Value;
type _RawStringsCannotCallUniquenessGuard = GuardAssertFalse<
  GuardAssignable<readonly string[], Parameters<typeof snapshotUniqueLogicalIds>[0]>
>;
type _CallerLabelCannotReachUniquenessGuard = GuardAssertFalse<
  GuardAssignable<[readonly string[], string], Parameters<typeof snapshotUniqueLogicalIds>>
>;
type _MissingCeilingCannotReachUniquenessGuard = GuardAssertFalse<
  GuardAssignable<[readonly ProviderLogicalIdV1[]], Parameters<typeof snapshotUniqueLogicalIds>>
>;
