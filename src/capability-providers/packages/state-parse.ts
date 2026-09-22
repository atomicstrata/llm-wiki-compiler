/**
 * @file src/capability-providers/packages/state-parse.ts
 * @description Bounded duplicate-key-free parsers for provider source and
 * install authority. Source continuity reuses the hardened TAP state parser;
 * provider install assertions are reparsed and rebranded field by field.
 */
import { parseBoundedUniqueJson } from "../../profile/templates/signing/json.js";
import { parseTapOperatorState } from "../../profile/templates/taps/state-parse.js";
import {
  parseProviderCoordinate, parseProviderId, parseSemanticVersion, parseSha256Digest,
} from "../ids.js";
import type { Sha256Digest } from "../types.js";
import type {
  ProviderInstallRecordV1, ProviderInstallState, ProviderInstallationSourceV1,
  ProviderLocalApprovalV1, ProviderSourcesState,
} from "./state-types.js";

export const MAX_PROVIDER_STATE_BYTES = 4 * 1024 * 1024;
const MAX_INSTALLS = 10_000;

/** Parse provider source trust and TAP continuity without weakening TAP rules. */
export function parseProviderSourcesState(text: string): ProviderSourcesState {
  const root = object(parseBoundedUniqueJson(text, MAX_PROVIDER_STATE_BYTES), "provider sources");
  exact(root, ["schemaVersion", "sources"]);
  if (root.schemaVersion !== 1) throw new Error("provider sources schemaVersion must be 1");
  const tapState = parseTapOperatorState(JSON.stringify({ schemaVersion: 1, taps: root.sources }));
  return Object.freeze({ schemaVersion: 1, sources: Object.freeze(tapState.taps) });
}

/** Parse exact immutable installation records and bind map keys to digests. */
export function parseProviderInstallState(text: string): ProviderInstallState {
  const root = object(parseBoundedUniqueJson(text, MAX_PROVIDER_STATE_BYTES), "provider installs");
  exact(root, ["schemaVersion", "installs", "localApprovals"]);
  if (root.schemaVersion !== 1) throw new Error("provider installs schemaVersion must be 1");
  const raw = object(root.installs, "provider install map");
  if (Object.keys(raw).length > MAX_INSTALLS) throw new Error("provider install map exceeds its item cap");
  const installs = Object.create(null) as Record<string, ProviderInstallRecordV1>;
  for (const [digest, value] of Object.entries(raw)) {
    const parsedDigest = parseSha256Digest(digest);
    const record = parseInstall(value);
    if (record.packageDigest !== parsedDigest) throw new Error("provider install map key differs from package digest");
    installs[digest] = record;
  }
  const localApprovals = parseLocalApprovals(root.localApprovals);
  for (const digest of Object.keys(localApprovals)) {
    if (installs[digest]?.sourceType !== "local-development") {
      throw new Error("provider local approval is not bound to a local-development install");
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    installs: Object.freeze(installs),
    localApprovals,
  });
}

function parseLocalApprovals(value: unknown): Readonly<Record<string, ProviderLocalApprovalV1>> {
  const raw = object(value, "provider local approval map");
  if (Object.keys(raw).length > MAX_INSTALLS) throw new Error("provider local approval map exceeds its item cap");
  const approvals = Object.create(null) as Record<string, ProviderLocalApprovalV1>;
  for (const [digest, approvalValue] of Object.entries(raw)) {
    const packageDigest = parseSha256Digest(digest);
    const approval = object(approvalValue, "provider local approval");
    exact(approval, ["packageDigest", "approvedAt"]);
    if (parseSha256Digest(approval.packageDigest) !== packageDigest) {
      throw new Error("provider local approval key differs from package digest");
    }
    approvals[digest] = Object.freeze({ packageDigest, approvedAt: timestamp(approval.approvedAt, "approvedAt") });
  }
  return Object.freeze(approvals);
}

function parseInstall(value: unknown): ProviderInstallRecordV1 {
  const obj = object(value, "provider install record");
  exact(obj, [
    "packageDigest", "coordinate", "providerId", "providerVersion", "manifestDigest",
    "artifactId", "artifactDigest", "expandedTreeDigest", "sourceType", "installedAt",
    "tapSequence", "publisherKeyId", "acceptedIndexDigest",
  ]);
  const coordinate = parseProviderCoordinate(obj.coordinate);
  const providerId = parseProviderId(obj.providerId);
  const providerVersion = parseSemanticVersion(obj.providerVersion);
  if (coordinate.providerId !== providerId || coordinate.providerVersion !== providerVersion) {
    throw new Error("provider install identity differs from coordinate");
  }
  const record = {
    packageDigest: parseSha256Digest(obj.packageDigest), coordinate: coordinate.coordinate,
    providerId, providerVersion, manifestDigest: parseSha256Digest(obj.manifestDigest),
    artifactId: slug(obj.artifactId, "artifact ID"), artifactDigest: parseSha256Digest(obj.artifactDigest),
    expandedTreeDigest: parseSha256Digest(obj.expandedTreeDigest), sourceType: sourceType(obj.sourceType),
    installedAt: timestamp(obj.installedAt, "installedAt"), tapSequence: optionalInteger(obj.tapSequence),
    publisherKeyId: optionalText(obj.publisherKeyId), acceptedIndexDigest: optionalDigest(obj.acceptedIndexDigest),
  };
  assertSourceEvidence(record);
  return Object.freeze(record);
}

function assertSourceEvidence(record: ProviderInstallRecordV1): void {
  const hasRemote = record.tapSequence !== null && record.publisherKeyId !== null
    && record.acceptedIndexDigest !== null;
  const hasNoRemote = record.tapSequence === null && record.publisherKeyId === null
    && record.acceptedIndexDigest === null;
  const consistent = record.sourceType === "signed-remote" ? hasRemote : hasNoRemote;
  if (!consistent) throw new Error(`${record.sourceType} provider install has inconsistent provenance`);
}

function sourceType(value: unknown): ProviderInstallationSourceV1 {
  if (value !== "signed-remote" && value !== "local-development" && value !== "builtin") {
    throw new Error("provider installation source is invalid");
  }
  return value;
}

// State and signed-envelope parsers retain distinct exact-shape boundaries.
// fallow-ignore-next-line code-duplication
function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exact(obj: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(obj).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error("provider state record has unsupported or missing fields");
  }
}

function slug(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result)) throw new Error(`${label} is invalid`);
  return result;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 4096) throw new Error(`${label} is invalid`);
  return value;
}

function optionalText(value: unknown): string | null {
  return value === null ? null : text(value, "publisher key ID");
}

function optionalDigest(value: unknown): Sha256Digest | null {
  return value === null ? null : parseSha256Digest(value);
}

function optionalInteger(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("tap sequence is invalid");
  return Number(value);
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label);
  if (new Date(result).toISOString() !== result) throw new Error(`${label} must be canonical UTC time`);
  return result;
}
