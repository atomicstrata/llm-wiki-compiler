/**
 * @file src/capability-providers/authority/grants-resolve.ts
 * @description Host derivation of persisted operator authority and immutable
 * effective grants. Callers pin grant/effect/pricing revisions, but only the
 * owner-private stores supply privilege-raising scope and credential mappings.
 */
import { realpath, stat } from "node:fs/promises";
import { BROKER_AGGREGATE_MAXIMUM_CEILINGS, BROKER_AGGREGATE_MAXIMUM_KEYS } from "../constants.js";
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import { captureExactRecord } from "../../utils/runtime-capture.js";
import { isWellFormedUnicode } from "../../utils/well-formed-unicode.js";
import { parseCapabilityId, parseRequestId, parseSha256Digest } from "../ids.js";
import type { AuthorizedProviderPaths } from "../packages/paths.js";
import type { ProviderBoundsV1, ProviderPinV1, Sha256Digest } from "../types.js";
import {
  assertCredentialHandleBinding, readCredentialRegistryState,
} from "./credentials.js";
import { effectPlanDigest, parseEffectPlan } from "./effect-plan.js";
import { snapshotProviderExposure } from "./exposure.js";
import {
  grantRequestDigestClaim, parseAuthorityProviderPin, parseProviderBounds,
  parseProviderGrantScope,
} from "./grants-parse.js";
import { appendProviderOperatorGrant, readProviderGrantState } from "./grants-store.js";
import { hostPriceTableDigest, readHostPriceTable } from "./pricing.js";
import type {
  EffectiveProviderGrantRequestV1, EffectiveProviderGrantV1,
  ProviderAuthorityAtomV1, ProviderBrokerMaximumsV1, ProviderEffectPlanV1,
  ProviderGrantScopeV1, ProviderInputExposureSetV1, ProviderOperatorGrantRecordV1,
  WriteOperatorGrantRequestV1,
} from "./types.js";

const REQUEST_KEYS = Object.freeze([
  "schemaVersion", "providerPin", "projectRealpathDigest", "capabilityId", "workspaceId",
  "preparationRunId", "surface", "safetyFloorVersion", "hostFloor", "providerMaximum",
  "operationsPackRequest", "operatorGrantId", "operatorGrantRevision",
  "operatorGrantRequestDigest", "effectPlan", "priceTableDigest", "resourceBounds",
  "surfaceCap", "exposureInputs",
] as const);
const WRITE_KEYS = Object.freeze([
  "grantId", "projectRoot", "providerPin", "grant", "confirmedGrantRequestDigest", "createdAt",
] as const);
const BOUND_KEYS = Object.freeze([
  "structuredInputBytes", "materializedInputFiles", "materializedInputBytes",
  "scratchFiles", "scratchBytes", "outputFiles", "outputBytes", "custodyScanBytes",
  "custodyWallTimeMs", "protocolFrames", "protocolBytes", "brokerRequests",
  "mutatingEffects", "wallTimeMs", "cpuTimeMs", "memoryBytes", "processCount",
] as const satisfies readonly (keyof ProviderBoundsV1)[]);

/** Resolve authority only from the exact operator state selected by host paths. */
export async function resolveEffectiveProviderGrant(
  paths: AuthorizedProviderPaths,
  request: EffectiveProviderGrantRequestV1,
): Promise<EffectiveProviderGrantV1> {
  try {
    const parsed = parseEffectiveRequest(request);
    const operator = await requireOperatorGrant(paths, parsed);
    const authority = intersectRequiredAuthority(parsed, operator.grant, parsed.effectPlan);
    const bounds = minimumBounds(parsed, operator.grant.bounds, parsed.effectPlan.bounds);
    const brokerMaximums = minimumBrokerMaximums(parsed, operator.grant);
    const exposure = snapshotProviderExposure(parsed.exposureInputs);
    validateExposure(exposure, authority, bounds);
    await validateCredentialBindings(paths, authority);
    const priceTableDigest = await verifyPriceTableDigest(paths, parsed.priceTableDigest, authority);
    return buildEffectiveGrant(
      parsed, operator, authority, bounds, brokerMaximums, exposure, priceTableDigest,
    );
  } catch (error) {
    if (isStableAuthorityError(error)) throw error;
    throw new Error("provider grant is invalid");
  }
}

/** Canonical confirmation digest displayed before an operator grant write. */
export function operatorGrantRequestDigest(
  providerPin: ProviderPinV1,
  grant: ProviderGrantScopeV1,
  projectRealpathDigest: Sha256Digest,
): Sha256Digest {
  return grantRequestDigestClaim(
    parseAuthorityProviderPin(providerPin), parseProviderGrantScope(grant),
    parseSha256Digest(projectRealpathDigest),
  );
}

/** Bind operator authority to the canonical project realpath, never project bytes. */
export async function projectGrantScopeDigest(projectRoot: string): Promise<Sha256Digest> {
  try {
    if (typeof projectRoot !== "string" || projectRoot.length === 0
      || !isWellFormedUnicode(projectRoot)) throw new Error();
    const canonicalProjectRoot = await realpath(projectRoot);
    if (!(await stat(canonicalProjectRoot)).isDirectory()) throw new Error();
    return digest({ domain: "llmwiki-provider-project-grant-scope-v1", canonicalProjectRoot });
  } catch { throw new Error("provider project grant scope is unavailable"); }
}

/** Perform the sole Task 5 operator grant transaction under the provider lock. */
export async function writeOperatorGrant(
  paths: AuthorizedProviderPaths,
  request: WriteOperatorGrantRequestV1,
): Promise<ProviderOperatorGrantRecordV1> {
  const parsed = parseWriteRequest(request);
  const projectRealpathDigest = await projectGrantScopeDigest(parsed.projectRoot);
  const expectedConfirmation = grantRequestDigestClaim(
    parsed.providerPin, parsed.grant, projectRealpathDigest,
  );
  if (parsed.confirmedGrantRequestDigest !== expectedConfirmation) {
    throw new Error("provider grant confirmation does not match the request");
  }
  const record = Object.freeze({
    grantId: parsed.grantId, revision: 1, projectRealpathDigest,
    providerPin: parsed.providerPin, providerPinDigest: pinDigest(parsed.providerPin),
    grantRequestDigest: expectedConfirmation, grant: parsed.grant, createdAt: parsed.createdAt,
  });
  await appendProviderOperatorGrant(paths, record);
  return record;
}

function parseEffectiveRequest(request: EffectiveProviderGrantRequestV1): EffectiveProviderGrantRequestV1 {
  const value = captureExactRecord(request, REQUEST_KEYS);
  if (value.schemaVersion !== 1) throw grantInvalidError();
  const providerPin = parseAuthorityProviderPin(value.providerPin);
  const capabilityId = parseCapabilityId(value.capabilityId);
  if (providerPin.capabilityId !== capabilityId) throw grantInvalidError();
  const surface = value.surface;
  if (surface !== "cli" && surface !== "sdk" && surface !== "mcp") throw grantInvalidError();
  const exposureInputs = snapshotProviderExposure(
    value.exposureInputs as EffectiveProviderGrantRequestV1["exposureInputs"],
  ).inputs;
  return Object.freeze({
    schemaVersion: 1, providerPin, projectRealpathDigest: parseSha256Digest(value.projectRealpathDigest),
    capabilityId, workspaceId: identifier(value.workspaceId),
    preparationRunId: identifier(value.preparationRunId), surface,
    safetyFloorVersion: versionToken(value.safetyFloorVersion),
    hostFloor: parseProviderGrantScope(value.hostFloor),
    providerMaximum: parseProviderGrantScope(value.providerMaximum),
    operationsPackRequest: parseProviderGrantScope(value.operationsPackRequest),
    operatorGrantId: parseRequestId(value.operatorGrantId),
    operatorGrantRevision: positiveInteger(value.operatorGrantRevision),
    operatorGrantRequestDigest: parseSha256Digest(value.operatorGrantRequestDigest),
    effectPlan: parseEffectPlan(value.effectPlan),
    priceTableDigest: value.priceTableDigest === null ? null : parseSha256Digest(value.priceTableDigest),
    resourceBounds: parseProviderBounds(value.resourceBounds),
    surfaceCap: parseProviderBounds(value.surfaceCap),
    exposureInputs,
  });
}

async function requireOperatorGrant(
  paths: AuthorizedProviderPaths,
  request: EffectiveProviderGrantRequestV1,
): Promise<ProviderOperatorGrantRecordV1> {
  const read = await readProviderGrantState(paths);
  if (read.kind === "absent") throw new Error("provider grant is missing");
  if (read.kind !== "ok") throw new Error("provider grant store is unavailable");
  const record = read.state.grants[request.operatorGrantId];
  if (!record) throw new Error("provider grant is missing");
  const matches = record.revision === request.operatorGrantRevision
    && record.projectRealpathDigest === request.projectRealpathDigest
    && record.providerPinDigest === pinDigest(request.providerPin)
    && digest(record.providerPin) === digest(request.providerPin)
    && record.grantRequestDigest === request.operatorGrantRequestDigest;
  if (!matches) throw new Error("provider grant has drifted");
  return record;
}

function intersectRequiredAuthority(
  request: EffectiveProviderGrantRequestV1,
  operatorGrant: ProviderGrantScopeV1,
  effectPlan: ProviderEffectPlanV1,
): readonly ProviderAuthorityAtomV1[] {
  assertRequestScopesUseSlots(request);
  const required = request.operationsPackRequest.authority;
  const host = atomSet(request.hostFloor.authority), provider = atomSet(request.providerMaximum.authority);
  const result = required.map((atom) => {
    const atomDigest = canonicalDigest(atom);
    if (!host.has(atomDigest) || !provider.has(atomDigest)) throw grantMissingError();
    const effective = atom.kind === "credential.use"
      ? resolveCredentialAtom(atom, operatorGrant.authority)
      : requireOperatorAtom(atom, operatorGrant.authority);
    if (atom.effectClass !== null && !effectPlanCovers(atom, effectPlan)) throw grantMissingError();
    return effective;
  });
  return Object.freeze(result);
}

function assertRequestScopesUseSlots(request: EffectiveProviderGrantRequestV1): void {
  for (const scope of [request.hostFloor, request.providerMaximum, request.operationsPackRequest]) {
    if (scope.authority.some((atom) => atom.credentialHandleId !== null)) throw grantInvalidError();
  }
}

function resolveCredentialAtom(
  requested: ProviderAuthorityAtomV1,
  operatorAuthority: readonly ProviderAuthorityAtomV1[],
): ProviderAuthorityAtomV1 {
  const key = credentialRequestDigest(requested);
  const matches = operatorAuthority.filter((atom) => atom.kind === "credential.use"
    && atom.credentialHandleId !== null && credentialRequestDigest(atom) === key);
  if (matches.length !== 1) throw grantMissingError();
  return Object.freeze({ ...requested, credentialHandleId: matches[0].credentialHandleId });
}

function requireOperatorAtom(
  requested: ProviderAuthorityAtomV1,
  operatorAuthority: readonly ProviderAuthorityAtomV1[],
): ProviderAuthorityAtomV1 {
  const requestedDigest = canonicalDigest(requested);
  if (!operatorAuthority.some((atom) => canonicalDigest(atom) === requestedDigest)) throw grantMissingError();
  return requested;
}

function credentialRequestDigest(atom: ProviderAuthorityAtomV1): string {
  return canonicalDigest({ ...atom, credentialHandleId: null });
}

function effectPlanCovers(atom: ProviderAuthorityAtomV1, plan: ProviderEffectPlanV1): boolean {
  return plan.entries.some((entry) => entry.brokerId === atom.brokerId
    && entry.effectClass === atom.effectClass && entry.targetIdentity === atom.target);
}

function atomSet(authority: readonly ProviderAuthorityAtomV1[]): ReadonlySet<string> {
  return new Set(authority.map((atom) => canonicalDigest(atom)));
}

function minimumBounds(
  request: EffectiveProviderGrantRequestV1,
  operatorBounds: ProviderBoundsV1,
  effectBounds: ProviderBoundsV1,
): ProviderBoundsV1 {
  const legs = [request.hostFloor.bounds, request.providerMaximum.bounds,
    request.operationsPackRequest.bounds, operatorBounds, effectBounds,
    request.resourceBounds, request.surfaceCap];
  const minimum = {} as Record<keyof ProviderBoundsV1, number>;
  for (const key of BOUND_KEYS) minimum[key] = Math.min(...legs.map((bounds) => bounds[key]));
  return Object.freeze(minimum) as ProviderBoundsV1;
}

function minimumBrokerMaximums(
  request: EffectiveProviderGrantRequestV1,
  operatorGrant: ProviderGrantScopeV1,
): ProviderBrokerMaximumsV1 {
  const legs = [request.hostFloor, request.providerMaximum,
    request.operationsPackRequest, operatorGrant];
  const resolved = {} as Record<keyof ProviderBrokerMaximumsV1, number>;
  for (const key of BROKER_AGGREGATE_MAXIMUM_KEYS) {
    const tightened = legs
      .map((scope) => scope.brokerMaximums?.[key])
      .filter((value): value is number => value !== undefined);
    resolved[key] = Math.min(BROKER_AGGREGATE_MAXIMUM_CEILINGS[key], ...tightened);
  }
  return Object.freeze(resolved) as ProviderBrokerMaximumsV1;
}

function validateExposure(
  exposure: ProviderInputExposureSetV1,
  authority: readonly ProviderAuthorityAtomV1[],
  bounds: ProviderBoundsV1,
): void {
  if (exposure.inputs.length > bounds.materializedInputFiles) throw exposureBoundsError();
  const allowedKinds = new Set(authority.filter((atom) => atom.kind === "source.read")
    .map((atom) => atom.inputKind));
  let totalBytes = 0;
  for (const input of exposure.inputs) {
    if (!allowedKinds.has(input.kind)) throw new Error("provider source authority is missing");
    if (input.byteCount > bounds.materializedInputBytes - totalBytes) throw exposureBoundsError();
    totalBytes += input.byteCount;
  }
}

async function validateCredentialBindings(
  paths: AuthorizedProviderPaths,
  authority: readonly ProviderAuthorityAtomV1[],
): Promise<void> {
  const atoms = authority.filter((atom) => atom.kind === "credential.use");
  if (atoms.length === 0) return;
  const read = await readCredentialRegistryState(paths);
  if (read.kind === "absent") throw new Error("provider credential is missing");
  if (read.kind !== "ok") throw new Error("provider credential store is unavailable");
  for (const atom of atoms) {
    if (atom.credentialSlotId === null || atom.credentialHandleId === null || atom.brokerId === null) {
      throw grantInvalidError();
    }
    assertCredentialHandleBinding(
      read.registry, atom.credentialSlotId, atom.credentialHandleId, atom.brokerId,
    );
  }
}

async function verifyPriceTableDigest(
  paths: AuthorizedProviderPaths,
  expected: Sha256Digest | null,
  authority: readonly ProviderAuthorityAtomV1[],
): Promise<Sha256Digest | null> {
  const modelAuthorized = authority.some((atom) => atom.kind === "model.invoke");
  if (expected === null) {
    if (modelAuthorized) throw new Error("provider pricing is unavailable");
    return null;
  }
  const actual = hostPriceTableDigest(await readHostPriceTable(paths));
  if (actual !== expected) throw new Error("provider pricing has drifted");
  return actual;
}

function buildEffectiveGrant(
  request: EffectiveProviderGrantRequestV1,
  operator: ProviderOperatorGrantRecordV1,
  authority: readonly ProviderAuthorityAtomV1[],
  bounds: ProviderBoundsV1,
  brokerMaximums: ProviderBrokerMaximumsV1,
  exposure: ProviderInputExposureSetV1,
  priceTableDigest: Sha256Digest | null,
): EffectiveProviderGrantV1 {
  const base = Object.freeze({
    schemaVersion: 1 as const, providerPinDigest: pinDigest(request.providerPin),
    projectRealpathDigest: request.projectRealpathDigest, capabilityId: request.capabilityId,
    workspaceId: request.workspaceId, preparationRunId: request.preparationRunId,
    surface: request.surface, safetyFloorVersion: request.safetyFloorVersion,
    operatorGrantId: operator.grantId, operatorGrantRevision: operator.revision,
    operatorGrantRequestDigest: operator.grantRequestDigest,
    effectPlanDigest: effectPlanDigest(request.effectPlan), priceTableDigest,
    authority, bounds, brokerMaximums, exposure,
  });
  return Object.freeze({ ...base, grantSnapshotDigest: digest(base) });
}

function parseWriteRequest(request: WriteOperatorGrantRequestV1): WriteOperatorGrantRequestV1 {
  try {
    const value = captureExactRecord(request, WRITE_KEYS);
    return Object.freeze({
      grantId: parseRequestId(value.grantId), projectRoot: requiredText(value.projectRoot),
      providerPin: parseAuthorityProviderPin(value.providerPin),
      grant: parseProviderGrantScope(value.grant),
      confirmedGrantRequestDigest: parseSha256Digest(value.confirmedGrantRequestDigest),
      createdAt: timestamp(value.createdAt),
    });
  } catch { throw grantInvalidError(); }
}

function pinDigest(providerPin: ProviderPinV1): Sha256Digest { return digest(providerPin); }
function digest(value: unknown): Sha256Digest { return parseSha256Digest(canonicalDigest(value)); }
function identifier(value: unknown): string {
  if (typeof value !== "string" || value.length > 128 || !isWellFormedUnicode(value)
    || !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(value)) throw grantInvalidError();
  return value;
}
function requiredText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || !isWellFormedUnicode(value)
    || Buffer.byteLength(value) > 4096) throw grantInvalidError();
  return value;
}
function versionToken(value: unknown): string {
  const result = requiredText(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) throw grantInvalidError();
  return result;
}
function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw grantInvalidError();
  return Number(value);
}
function timestamp(value: unknown): string {
  const result = requiredText(value);
  if (new Date(result).toISOString() !== result) throw grantInvalidError();
  return result;
}
function isStableAuthorityError(error: unknown): boolean {
  return error instanceof Error && /provider (grant|bounds|exposure|source|credential|pricing|effect)/.test(error.message);
}
function grantInvalidError(): Error { return new Error("provider grant is invalid"); }
function grantMissingError(): Error { return new Error("provider grant is missing required authority"); }
function exposureBoundsError(): Error { return new Error("provider exposure exceeds resolved bounds"); }
