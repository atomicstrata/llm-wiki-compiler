/**
 * @file src/capability-providers/authority/grants-parse.ts
 * @description Exact-shape, bounded parsing for provider authority scopes and
 * operator grant state. Runtime objects are captured without getters/proxies;
 * persisted JSON rejects duplicate keys before any authority is interpreted.
 */
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import { parseBoundedUniqueJson } from "../../profile/templates/signing/json.js";
import { captureDenseArray, captureExactRecord, captureOwnDataRecord } from "../../utils/runtime-capture.js";
import { isWellFormedUnicode } from "../../utils/well-formed-unicode.js";
import {
  parseBrokerId, parseCapabilityContractVersion, parseCapabilityId,
  parseProviderCoordinate, parseProviderId, parseRequestId, parseSemanticVersion,
  parseSha256Digest,
} from "../ids.js";
import { BROKER_AGGREGATE_MAXIMUM_CEILINGS, BROKER_AGGREGATE_MAXIMUM_KEYS } from "../constants.js";
import type { ProviderBoundsV1, ProviderPinV1, Sha256Digest } from "../types.js";
import {
  PROVIDER_GRANT_KINDS, type ProviderAuthorityAtomV1, type ProviderBrokerMaximumsV1,
  type ProviderGrantKindV1, type ProviderGrantScopeV1, type ProviderOperatorGrantStateV1,
  type ProviderOperatorGrantRecordV1,
} from "./types.js";

export const MAX_PROVIDER_GRANT_STATE_BYTES = 4 * 1024 * 1024;
const MAX_GRANTS = 10_000;
const MAX_AUTHORITY_ATOMS = 4_096;
const MAX_TEXT_BYTES = 4_096;
const BROKER_MAXIMUM_KEYS = BROKER_AGGREGATE_MAXIMUM_KEYS;
const BOUND_KEYS = Object.freeze([
  "structuredInputBytes", "materializedInputFiles", "materializedInputBytes",
  "scratchFiles", "scratchBytes", "outputFiles", "outputBytes", "custodyScanBytes",
  "custodyWallTimeMs", "protocolFrames", "protocolBytes", "brokerRequests",
  "mutatingEffects", "wallTimeMs", "cpuTimeMs", "memoryBytes", "processCount",
] as const satisfies readonly (keyof ProviderBoundsV1)[]);
const ATOM_KEYS = Object.freeze([
  "kind", "brokerId", "operation", "target", "method", "credentialSlotId",
  "credentialHandleId", "effectClass", "inputKind", "toolId",
] as const);
const ATOM_VALIDATORS: Readonly<Record<
  ProviderGrantKindV1, (atom: ProviderAuthorityAtomV1) => boolean
>> = Object.freeze({
  "source.read": validSourceAtom,
  "network.https": validNetworkAtom,
  "model.invoke": validTargetReadAtom,
  "credential.use": validCredentialAtom,
  "repository.snapshot": validTargetReadAtom,
  "command.execute": validCommandAtom,
  "external.mutate": validMutatingAtom,
  "scheduler.write": validMutatingAtom,
  "email.send": validMutatingAtom,
});

/** Capture one authority leg without retaining caller-owned arrays or objects. */
export function parseProviderGrantScope(value: unknown): ProviderGrantScopeV1 {
  try {
    const root = captureOwnDataRecord(value);
    const keys = Object.keys(root);
    const allowed = new Set(["schemaVersion", "authority", "bounds", "brokerMaximums"]);
    if (["schemaVersion", "authority", "bounds"].some((key) => !Object.hasOwn(root, key))
      || keys.some((key) => !allowed.has(key)) || root.schemaVersion !== 1) throw grantError();
    const authority = captureDenseArray(root.authority, MAX_AUTHORITY_ATOMS, parseAuthorityAtom, grantError);
    rejectDuplicateAtoms(authority);
    const brokerMaximums = parseBrokerMaximums(root.brokerMaximums);
    return Object.freeze({
      schemaVersion: 1, authority, bounds: parseProviderBounds(root.bounds),
      ...(brokerMaximums === undefined ? {} : { brokerMaximums }),
    });
  } catch (error) {
    if (error instanceof Error && error.message === boundsError().message) throw error;
    throw grantError();
  }
}

/**
 * Capture the optional per-broker aggregate maxima block. An omitted block or
 * omitted key contributes no tightening; a present key must be a bounded value
 * that only tightens (never exceeds) the named broker's host ceiling.
 */
function parseBrokerMaximums(
  value: unknown,
): Readonly<Partial<ProviderBrokerMaximumsV1>> | undefined {
  if (value === undefined) return undefined;
  const record = captureOwnDataRecord(value);
  const allowed = new Set<string>(BROKER_MAXIMUM_KEYS);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw grantError();
  const parsed: Record<string, number> = {};
  for (const key of BROKER_MAXIMUM_KEYS) {
    const candidate = record[key];
    if (candidate === undefined) continue;
    if (!validBrokerMaximum(key, candidate)) throw grantError();
    parsed[key] = Number(candidate);
  }
  return Object.freeze(parsed) as Readonly<Partial<ProviderBrokerMaximumsV1>>;
}

function validBrokerMaximum(
  key: keyof ProviderBrokerMaximumsV1, value: unknown,
): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    && (key === "modelCostUsd" || Number.isSafeInteger(value))
    && value <= BROKER_AGGREGATE_MAXIMUM_CEILINGS[key];
}

/** Capture a complete non-negative integer provider-bound record. */
export function parseProviderBounds(value: unknown): ProviderBoundsV1 {
  try {
    const record = captureExactRecord(value, BOUND_KEYS);
    const parsed = {} as Record<keyof ProviderBoundsV1, number>;
    for (const key of BOUND_KEYS) {
      const candidate = record[key];
      if (!validBound(key, candidate)) throw boundsError();
      parsed[key] = Number(candidate);
    }
    return Object.freeze(parsed) as ProviderBoundsV1;
  } catch { throw boundsError(); }
}

function validBound(_key: keyof ProviderBoundsV1, value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    && Number.isSafeInteger(value);
}

/** Parse one complete duplicate-key-free provider-grants.json payload. */
export function parseProviderGrantState(text: string): ProviderOperatorGrantStateV1 {
  try {
    const root = captureExactRecord(
      parseBoundedUniqueJson(text, MAX_PROVIDER_GRANT_STATE_BYTES), ["schemaVersion", "grants"],
    );
    if (root.schemaVersion !== 1) throw grantError();
    const raw = objectMap(root.grants);
    if (Object.keys(raw).length > MAX_GRANTS) throw grantError();
    const grants = Object.create(null) as Record<string, ProviderOperatorGrantRecordV1>;
    for (const [grantId, value] of Object.entries(raw)) {
      if (parseRequestId(grantId) !== grantId) throw grantError();
      grants[grantId] = parseGrantRecord(value, grantId);
    }
    return Object.freeze({ schemaVersion: 1, grants: Object.freeze(grants) });
  } catch { throw grantError(); }
}

/** Canonical operator confirmation claim shared by writer and loader. */
export function grantRequestDigestClaim(
  providerPin: ProviderPinV1,
  grant: ProviderGrantScopeV1,
  projectRealpathDigest: Sha256Digest,
): Sha256Digest {
  return parseSha256Digest(canonicalDigest({
    domain: "llmwiki-provider-grant-request-v1", providerPin, projectRealpathDigest, grant,
  }));
}

/** Parse and validate a complete exact provider pin from persisted authority. */
export function parseAuthorityProviderPin(value: unknown): ProviderPinV1 {
  try {
    const pin = captureExactRecord(value, [
      "schemaVersion", "coordinate", "providerId", "providerVersion", "packageDigest",
      "manifestDigest", "capabilityId", "capabilityContractVersion", "capabilitySchemaDigest",
    ]);
    if (pin.schemaVersion !== 1) throw grantError();
    const coordinate = parseProviderCoordinate(pin.coordinate);
    const providerId = parseProviderId(pin.providerId);
    const providerVersion = parseSemanticVersion(pin.providerVersion);
    if (coordinate.providerId !== providerId || coordinate.providerVersion !== providerVersion) throw grantError();
    return Object.freeze({
      schemaVersion: 1, coordinate: coordinate.coordinate, providerId, providerVersion,
      packageDigest: parseSha256Digest(pin.packageDigest),
      manifestDigest: parseSha256Digest(pin.manifestDigest),
      capabilityId: parseCapabilityId(pin.capabilityId),
      capabilityContractVersion: parseCapabilityContractVersion(pin.capabilityContractVersion),
      capabilitySchemaDigest: parseSha256Digest(pin.capabilitySchemaDigest),
    });
  } catch { throw grantError(); }
}

function parseGrantRecord(value: unknown, expectedGrantId: string): ProviderOperatorGrantRecordV1 {
  const record = captureExactRecord(value, [
    "grantId", "revision", "projectRealpathDigest", "providerPin", "providerPinDigest",
    "grantRequestDigest", "grant", "createdAt",
  ]);
  if (parseRequestId(record.grantId) !== expectedGrantId) throw grantError();
  if (!Number.isSafeInteger(record.revision) || Number(record.revision) <= 0) throw grantError();
  const projectRealpathDigest = parseSha256Digest(record.projectRealpathDigest);
  const providerPin = parseAuthorityProviderPin(record.providerPin);
  const providerPinDigest = parseSha256Digest(record.providerPinDigest);
  if (providerPinDigest !== canonicalPinDigest(providerPin)) throw grantError();
  const grant = parseProviderGrantScope(record.grant);
  const grantRequestDigest = parseSha256Digest(record.grantRequestDigest);
  if (grantRequestDigest !== grantRequestDigestClaim(providerPin, grant, projectRealpathDigest)) throw grantError();
  return Object.freeze({
    grantId: expectedGrantId, revision: Number(record.revision),
    projectRealpathDigest, providerPin,
    providerPinDigest, grantRequestDigest, grant, createdAt: timestamp(record.createdAt),
  });
}

function parseAuthorityAtom(value: unknown): ProviderAuthorityAtomV1 {
  const atom = captureExactRecord(value, ATOM_KEYS);
  const kind = grantKind(atom.kind);
  const parsed = Object.freeze({
    kind, brokerId: atom.brokerId === null ? null : parseBrokerId(atom.brokerId),
    operation: token(atom.operation), target: nullableText(atom.target),
    method: nullableMethod(atom.method), credentialSlotId: nullableToken(atom.credentialSlotId),
    credentialHandleId: nullableToken(atom.credentialHandleId),
    effectClass: nullableToken(atom.effectClass), inputKind: nullableToken(atom.inputKind),
    toolId: nullableToken(atom.toolId),
  });
  assertAtomGrammar(parsed);
  return parsed;
}

function assertAtomGrammar(atom: ProviderAuthorityAtomV1): void {
  if (!ATOM_VALIDATORS[atom.kind](atom)) throw grantError();
}

function validSourceAtom(atom: ProviderAuthorityAtomV1): boolean {
  return atom.brokerId === null && atom.inputKind !== null
    && !any(atom.target, atom.method, atom.credentialSlotId, atom.credentialHandleId, atom.effectClass, atom.toolId);
}
function validCredentialAtom(atom: ProviderAuthorityAtomV1): boolean {
  return commonBrokerAtom(atom) && atom.credentialSlotId !== null
    && !any(atom.target, atom.method, atom.effectClass, atom.toolId);
}
function validNetworkAtom(atom: ProviderAuthorityAtomV1): boolean {
  return commonBrokerAtom(atom) && atom.target !== null && atom.method !== null
    && noCredential(atom) && !any(atom.effectClass, atom.toolId);
}
function validCommandAtom(atom: ProviderAuthorityAtomV1): boolean {
  return commonBrokerAtom(atom) && atom.target !== null && atom.toolId !== null
    && noCredential(atom) && !any(atom.method, atom.effectClass);
}
function validTargetReadAtom(atom: ProviderAuthorityAtomV1): boolean {
  return commonBrokerAtom(atom) && atom.target !== null && noCredential(atom)
    && !any(atom.method, atom.effectClass, atom.toolId);
}
function validMutatingAtom(atom: ProviderAuthorityAtomV1): boolean {
  return commonBrokerAtom(atom) && atom.target !== null && atom.effectClass !== null
    && noCredential(atom) && !any(atom.method, atom.toolId);
}
function commonBrokerAtom(atom: ProviderAuthorityAtomV1): boolean {
  return atom.brokerId !== null && atom.inputKind === null;
}
function noCredential(atom: ProviderAuthorityAtomV1): boolean {
  return !any(atom.credentialSlotId, atom.credentialHandleId);
}

function rejectDuplicateAtoms(authority: readonly ProviderAuthorityAtomV1[]): void {
  const digests = authority.map((atom) => canonicalDigest(atom));
  if (new Set(digests).size !== digests.length) throw grantError();
}

function canonicalPinDigest(pin: ProviderPinV1): Sha256Digest {
  return parseSha256Digest(canonicalDigest(pin));
}

function objectMap(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw grantError();
  return captureExactRecord(value, Reflect.ownKeys(value).filter((key): key is string => typeof key === "string"));
}

function grantKind(value: unknown): ProviderGrantKindV1 {
  if (typeof value !== "string" || !PROVIDER_GRANT_KINDS.includes(value as ProviderGrantKindV1)) throw grantError();
  return value as ProviderGrantKindV1;
}

function token(value: unknown): string {
  const result = text(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) throw grantError();
  return result;
}

function nullableToken(value: unknown): string | null { return value === null ? null : token(value); }
function nullableText(value: unknown): string | null {
  if (value === null) return null;
  const result = text(value);
  if (result === "*" || /[\u0000-\u001f\u007f]/.test(result)) throw grantError();
  return result;
}
function nullableMethod(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[A-Z]{2,16}$/.test(value)) throw grantError();
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || !isWellFormedUnicode(value)
    || Buffer.byteLength(value) > MAX_TEXT_BYTES) throw grantError();
  return value;
}
function any(...values: readonly unknown[]): boolean { return values.some((value) => value !== null); }
function timestamp(value: unknown): string {
  const result = text(value);
  if (new Date(result).toISOString() !== result) throw grantError();
  return result;
}
function grantError(): Error { return new Error("provider grant is invalid"); }
function boundsError(): Error { return new Error("provider bounds are invalid"); }
