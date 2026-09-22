/**
 * @file src/capability-providers/packages/protocol.ts
 * @description Exact provider-specific package and manifest grammar. It reuses
 * bounded unique-key JSON and the closed schema parser while rebuilding only
 * allowlisted records; template payloads cannot cross this boundary.
 */
import {
  MAX_ACCEPTED_OUTPUT_BYTES, MAX_ACCEPTED_OUTPUT_FILES, MAX_BROKER_REQUESTS,
  MAX_COMPRESSED_PLATFORM_ARTIFACT_BYTES, MAX_CUSTODY_SCAN_BYTES,
  MAX_CUSTODY_WALL_TIME_MS, MAX_EXPANDED_PACKAGE_TREE_BYTES,
  MAX_MANIFEST_CAPABILITIES, MAX_MATERIALIZED_INPUT_BYTES,
  MAX_MATERIALIZED_INPUT_FILES, MAX_MUTATING_EFFECTS, MAX_PACKAGE_ENTRIES,
  MAX_PROTOCOL_STREAM_BYTES_PER_DIRECTION, MAX_PROTOCOL_STREAM_FRAMES,
  MAX_PROVIDER_CPU_TIME_MS, MAX_PROVIDER_MEMORY_BYTES, MAX_PROVIDER_PROCESSES,
  MAX_PROVIDER_WALL_TIME_MS, MAX_SCRATCH_BYTES, MAX_SCRATCH_ENTRIES,
  MAX_SIGNED_PROVIDER_ENVELOPE_BYTES, MAX_STRUCTURED_INPUT_BYTES,
} from "../constants.js";
import {
  parseCapabilityContractVersion, parseCapabilityId,
  parseProviderCoordinate, parseProviderId, parseSemanticVersion, parseSha256Digest,
} from "../ids.js";
import type {
  BrokerIdV1, CapabilityContractVersionV1, CapabilityIdV1, ProviderBoundsV1,
  ProviderCoordinateV1, ProviderIdV1, SemanticVersionV1, Sha256Digest,
} from "../types.js";
import { parseBrokerRequirements } from "./broker-requirement.js";
import { parseClosedProviderSchema } from "../schema/parse.js";
import type { ClosedProviderSchemaV1 } from "../schema/types.js";
import { parseBoundedUniqueJson } from "../../profile/templates/signing/json.js";
import type { Ed25519Signature } from "../../profile/templates/signing/types.js";

export interface PlatformArtifactRefV1 {
  readonly artifactId: string;
  readonly os: string;
  readonly architecture: string;
  readonly artifactDigest: Sha256Digest;
}

export interface PlatformArtifactV1 extends PlatformArtifactRefV1 {
  readonly archiveFormat: "tar" | "zip";
  readonly archiveByteCount: number;
  readonly expandedTreeDigest: Sha256Digest;
  readonly expandedByteCount: number;
  readonly entryCount: number;
  readonly entrypointRelativePath: string;
}

export interface BrokerRequirementV1 {
  readonly brokerId: BrokerIdV1;
  readonly brokerContractVersion: string;
  readonly operations: readonly string[];
  readonly effectClass: string;
  readonly access: "read-only" | "mutating";
  readonly requiredCredentialSlots: readonly string[];
  readonly exposedInputKinds: readonly string[];
  readonly targetConstraints: Readonly<Record<string, unknown>>;
  readonly maximums: Readonly<Record<string, number>>;
}

export interface ArtifactOutputContractV1 {
  readonly outputId: string;
  readonly required: boolean;
  readonly mediaTypes: readonly string[];
  readonly maximumFiles: number;
  readonly maximumBytes: number;
}

export interface CapabilityDescriptorV1 {
  readonly capabilityId: CapabilityIdV1;
  readonly contractVersion: CapabilityContractVersionV1;
  readonly summary: string;
  readonly inputSchema: ClosedProviderSchemaV1;
  readonly outputSchema: ClosedProviderSchemaV1;
  readonly progressSchema?: ClosedProviderSchemaV1;
  readonly brokerRequirements: readonly BrokerRequirementV1[];
  readonly artifactOutputs: readonly ArtifactOutputContractV1[];
  readonly defaultBounds: ProviderBoundsV1;
  readonly hardMaximums: ProviderBoundsV1;
  readonly supportsCheckpoint: boolean;
  readonly supportsCooperativeCancel: boolean;
}

export interface ProviderManifestV1 {
  readonly schemaVersion: 1;
  readonly providerId: ProviderIdV1;
  readonly providerVersion: SemanticVersionV1;
  readonly protocolVersions: readonly string[];
  readonly capabilities: readonly CapabilityDescriptorV1[];
  readonly isolationClass: "host-brokered-process-v1";
  readonly platformArtifacts: readonly PlatformArtifactRefV1[];
}

export interface CapabilityProviderPackageV1 {
  readonly schemaVersion: 1;
  readonly packageKind: "capability-provider";
  readonly providerId: ProviderIdV1;
  readonly providerVersion: SemanticVersionV1;
  readonly publisher: string;
  readonly minLlmwikiVersion: SemanticVersionV1;
  readonly manifest: ProviderManifestV1;
  readonly artifacts: readonly PlatformArtifactV1[];
}

export interface ParsedProviderPackageEnvelope {
  readonly schemaVersion: 1;
  readonly coordinate: ProviderCoordinateV1;
  readonly payload: CapabilityProviderPackageV1;
  readonly payloadDigest: Sha256Digest;
  readonly publisherSignature: Ed25519Signature;
}

const BOUNDS = {
  structuredInputBytes: MAX_STRUCTURED_INPUT_BYTES,
  materializedInputFiles: MAX_MATERIALIZED_INPUT_FILES,
  materializedInputBytes: MAX_MATERIALIZED_INPUT_BYTES,
  scratchFiles: MAX_SCRATCH_ENTRIES,
  scratchBytes: MAX_SCRATCH_BYTES,
  outputFiles: MAX_ACCEPTED_OUTPUT_FILES,
  outputBytes: MAX_ACCEPTED_OUTPUT_BYTES,
  custodyScanBytes: MAX_CUSTODY_SCAN_BYTES,
  custodyWallTimeMs: MAX_CUSTODY_WALL_TIME_MS,
  protocolFrames: MAX_PROTOCOL_STREAM_FRAMES,
  protocolBytes: MAX_PROTOCOL_STREAM_BYTES_PER_DIRECTION,
  brokerRequests: MAX_BROKER_REQUESTS,
  mutatingEffects: MAX_MUTATING_EFFECTS,
  wallTimeMs: MAX_PROVIDER_WALL_TIME_MS,
  cpuTimeMs: MAX_PROVIDER_CPU_TIME_MS,
  memoryBytes: MAX_PROVIDER_MEMORY_BYTES,
  processCount: MAX_PROVIDER_PROCESSES,
} as const;

/** Parse only a capability-provider package envelope, never a template. */
export function parseProviderPackageEnvelope(text: string): ParsedProviderPackageEnvelope {
  const root = object(parseBoundedUniqueJson(text, MAX_SIGNED_PROVIDER_ENVELOPE_BYTES), "provider envelope");
  exact(root, ["schemaVersion", "coordinate", "payload", "payloadDigest", "publisherSignature"]);
  equal(root.schemaVersion, 1, "provider envelope schemaVersion must be 1");
  return Object.freeze({
    schemaVersion: 1,
    coordinate: parseProviderCoordinate(root.coordinate).coordinate,
    payload: parseCapabilityProviderPackage(root.payload),
    payloadDigest: parseSha256Digest(root.payloadDigest),
    publisherSignature: signature(root.publisherSignature),
  });
}

/** Parse a provider payload for builtin or explicitly local installation. */
export function parseCapabilityProviderPackage(value: unknown): CapabilityProviderPackageV1 {
  const obj = object(value, "provider payload");
  equal(obj.packageKind, "capability-provider", "provider payload packageKind must be capability-provider");
  exact(obj, ["schemaVersion", "packageKind", "providerId", "providerVersion", "publisher", "minLlmwikiVersion", "manifest", "artifacts"]);
  equal(obj.schemaVersion, 1, "provider payload schemaVersion must be 1");
  const payload = {
    schemaVersion: 1 as const,
    packageKind: "capability-provider" as const,
    providerId: parseProviderId(obj.providerId),
    providerVersion: parseSemanticVersion(obj.providerVersion),
    publisher: slug(obj.publisher, "publisher"),
    minLlmwikiVersion: parseSemanticVersion(obj.minLlmwikiVersion),
    manifest: parseManifest(obj.manifest),
    artifacts: array(obj.artifacts, "artifacts", 64).map(parseArtifact),
  };
  if (payload.artifacts.length === 0) throw new Error("provider package declares no platform artifacts");
  rejectDuplicate(payload.artifacts.map((item) => item.artifactId), "artifact ID");
  rejectDuplicate(
    payload.artifacts.map((item) => `${item.os}\0${item.architecture}`),
    "artifact platform tuple",
  );
  validateArtifactReferences(payload.manifest.platformArtifacts, payload.artifacts);
  if (payload.manifest.providerId !== payload.providerId
    || payload.manifest.providerVersion !== payload.providerVersion) {
    throw new Error("provider payload and manifest identity differ");
  }
  return deepFreeze(payload);
}

/** Select the package's sole artifact for the current host platform. */
export function selectHostPlatformArtifact(
  payload: CapabilityProviderPackageV1,
): PlatformArtifactV1 {
  const matches = payload.artifacts.filter((item) => (
    item.os === process.platform && item.architecture === process.arch
  ));
  if (matches.length !== 1) throw new Error("provider package must declare exactly one artifact for this host");
  return matches[0];
}

function parseManifest(value: unknown): ProviderManifestV1 {
  const obj = object(value, "provider manifest");
  exact(obj, ["schemaVersion", "providerId", "providerVersion", "protocolVersions", "capabilities", "isolationClass", "platformArtifacts"]);
  equal(obj.schemaVersion, 1, "provider manifest schemaVersion must be 1");
  equal(obj.isolationClass, "host-brokered-process-v1", "provider isolationClass is unsupported");
  const capabilities = array(obj.capabilities, "capabilities", MAX_MANIFEST_CAPABILITIES).map(parseCapability);
  if (capabilities.length === 0) throw new Error("provider manifest declares no capabilities");
  rejectDuplicate(capabilities.map((item) => item.capabilityId), "capability ID");
  const protocols = stringArray(obj.protocolVersions, "protocolVersions", 32);
  if (protocols.length === 0) throw new Error("provider manifest declares no protocol versions");
  return deepFreeze({
    schemaVersion: 1,
    providerId: parseProviderId(obj.providerId),
    providerVersion: parseSemanticVersion(obj.providerVersion),
    protocolVersions: protocols,
    capabilities,
    isolationClass: "host-brokered-process-v1",
    platformArtifacts: array(obj.platformArtifacts, "platformArtifacts", 64).map((item) => parseArtifactRef(item)),
  });
}

function parseCapability(value: unknown): CapabilityDescriptorV1 {
  const obj = object(value, "capability descriptor");
  exact(obj, ["capabilityId", "contractVersion", "summary", "inputSchema", "outputSchema", "progressSchema", "brokerRequirements", "artifactOutputs", "defaultBounds", "hardMaximums", "supportsCheckpoint", "supportsCooperativeCancel"], ["progressSchema"]);
  const capability = {
    capabilityId: parseCapabilityId(obj.capabilityId),
    contractVersion: parseCapabilityContractVersion(obj.contractVersion),
    summary: text(obj.summary, "capability summary", 4096),
    inputSchema: schema(obj.inputSchema),
    outputSchema: schema(obj.outputSchema),
    ...(obj.progressSchema === undefined ? {} : { progressSchema: schema(obj.progressSchema) }),
    brokerRequirements: parseBrokerRequirements(obj.brokerRequirements),
    artifactOutputs: array(obj.artifactOutputs, "artifactOutputs", 128).map(parseOutput),
    defaultBounds: bounds(obj.defaultBounds),
    hardMaximums: bounds(obj.hardMaximums),
    supportsCheckpoint: bool(obj.supportsCheckpoint, "supportsCheckpoint"),
    supportsCooperativeCancel: bool(obj.supportsCooperativeCancel, "supportsCooperativeCancel"),
  };
  rejectDuplicate(capability.artifactOutputs.map((item) => item.outputId), "artifact output ID");
  assertBoundsWithin(capability.defaultBounds, capability.hardMaximums);
  return deepFreeze(capability);
}

function parseOutput(value: unknown): ArtifactOutputContractV1 {
  const obj = object(value, "artifact output");
  exact(obj, ["outputId", "required", "mediaTypes", "maximumFiles", "maximumBytes"]);
  return deepFreeze({
    outputId: slug(obj.outputId, "output ID"),
    required: bool(obj.required, "output required"),
    mediaTypes: stringArray(obj.mediaTypes, "media types", 128),
    maximumFiles: integer(obj.maximumFiles, "maximumFiles", MAX_ACCEPTED_OUTPUT_FILES),
    maximumBytes: integer(obj.maximumBytes, "maximumBytes", MAX_ACCEPTED_OUTPUT_BYTES),
  });
}

function parseArtifact(value: unknown): PlatformArtifactV1 {
  const obj = object(value, "platform artifact");
  exact(obj, ["artifactId", "os", "architecture", "artifactDigest", "archiveFormat", "archiveByteCount", "expandedTreeDigest", "expandedByteCount", "entryCount", "entrypointRelativePath"]);
  if (obj.archiveFormat !== "tar" && obj.archiveFormat !== "zip") throw new Error("provider archive format is unsupported");
  return deepFreeze({
    ...parseArtifactRef(obj, true),
    archiveFormat: obj.archiveFormat,
    archiveByteCount: integer(obj.archiveByteCount, "archiveByteCount", MAX_COMPRESSED_PLATFORM_ARTIFACT_BYTES),
    expandedTreeDigest: parseSha256Digest(obj.expandedTreeDigest),
    expandedByteCount: integer(obj.expandedByteCount, "expandedByteCount", MAX_EXPANDED_PACKAGE_TREE_BYTES),
    entryCount: integer(obj.entryCount, "entryCount", MAX_PACKAGE_ENTRIES),
    entrypointRelativePath: relativePath(obj.entrypointRelativePath),
  });
}

function parseArtifactRef(value: unknown, insideArtifact = false): PlatformArtifactRefV1 {
  const obj = object(value, "platform artifact reference");
  if (!insideArtifact) exact(obj, ["artifactId", "os", "architecture", "artifactDigest"]);
  for (const required of ["artifactId", "os", "architecture", "artifactDigest"]) {
    if (!(required in obj)) throw new Error("platform artifact reference is incomplete");
  }
  return deepFreeze({
    artifactId: slug(obj.artifactId, "artifact ID"),
    os: slug(obj.os, "artifact OS"),
    architecture: slug(obj.architecture, "artifact architecture"),
    artifactDigest: parseSha256Digest(obj.artifactDigest),
  });
}

function bounds(value: unknown): ProviderBoundsV1 {
  const obj = object(value, "provider bounds");
  exact(obj, Object.keys(BOUNDS));
  return deepFreeze(Object.fromEntries(Object.entries(BOUNDS).map(([key, maximum]) => (
    [key, providerBound(obj[key], `provider bound ${key}`, maximum, key)]
  ))) as unknown as ProviderBoundsV1);
}

function providerBound(
  value: unknown, label: string, maximum: number, key: string,
): number {
  if (key !== "modelCostUsd") return integer(value, label, maximum);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new Error(`${label} must be a bounded number`);
  }
  return value;
}

function assertBoundsWithin(defaults: ProviderBoundsV1, maxima: ProviderBoundsV1): void {
  for (const key of Object.keys(BOUNDS) as Array<keyof ProviderBoundsV1>) {
    if (defaults[key] > maxima[key]) throw new Error(`default provider bound exceeds hard maximum: ${key}`);
  }
}

function schema(value: unknown): ClosedProviderSchemaV1 {
  return parseClosedProviderSchema(JSON.stringify(value)).schema;
}

function validateArtifactReferences(refs: readonly PlatformArtifactRefV1[], artifacts: readonly PlatformArtifactV1[]): void {
  rejectDuplicate(refs.map((item) => item.artifactId), "platform artifact reference");
  if (refs.length !== artifacts.length) throw new Error("platform artifact declarations differ");
  for (const ref of refs) {
    const artifact = artifacts.find((item) => item.artifactId === ref.artifactId);
    if (!artifact || artifact.os !== ref.os || artifact.architecture !== ref.architecture
      || artifact.artifactDigest !== ref.artifactDigest) throw new Error("platform artifact reference differs from signed artifact");
  }
}

function signature(value: unknown): Ed25519Signature {
  const obj = object(value, "publisher signature");
  exact(obj, ["keyId", "algorithm", "value"]);
  equal(obj.algorithm, "ed25519", "provider signature algorithm must be ed25519");
  const keyId = text(obj.keyId, "signature keyId", 128);
  const encoded = text(obj.value, "signature value", 4096);
  if (Buffer.from(encoded, "base64").toString("base64") !== encoded) throw new Error("provider signature value is invalid");
  return Object.freeze({ keyId, algorithm: "ed25519", value: encoded });
}

function relativePath(value: unknown): string {
  const result = text(value, "entrypointRelativePath", 4096);
  if (result.includes("\\") || result.startsWith("/") || result.split("/").some((part) => (
    !/^[a-zA-Z0-9._-]+$/.test(part) || part === "." || part === ".."
  ))) {
    throw new Error("entrypointRelativePath is unsafe");
  }
  return result;
}

function stringArray(value: unknown, label: string, maximum: number): readonly string[] {
  const values = array(value, label, maximum).map((item) => text(item, label, 4096));
  rejectDuplicate(values, label);
  return Object.freeze(values);
}

function array(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} must be a bounded array`);
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exact(obj: Record<string, unknown>, keys: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set(keys);
  if (Object.keys(obj).some((key) => !allowed.has(key))) throw new Error("provider record has unsupported fields");
  if (keys.some((key) => !optional.includes(key) && !(key in obj))) throw new Error("provider record is missing required fields");
}

function slug(value: unknown, label: string): string {
  const result = text(value, label, 128);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result)) throw new Error(`${label} is invalid`);
  return result;
}

function text(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > maximumBytes) throw new Error(`${label} must be bounded text`);
  return value;
}

function integer(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) throw new Error(`${label} must be a bounded integer`);
  return Number(value);
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(message);
}

function rejectDuplicate(values: readonly unknown[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} is duplicated`);
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
