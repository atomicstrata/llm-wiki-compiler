/**
 * @file src/capability-providers/packages/resolve.ts
 * @description Exact installed-provider resolution over Task 3 immutable
 * custody state. It accepts one complete pin, rechecks present revocation and
 * compatibility evidence, and returns a process-local one-use opaque token.
 */
import path from "node:path";
import packageJson from "../../../package.json" with { type: "json" };
import { canonicalBytes, canonicalDigest, packageClaim } from "../../profile/templates/signing/canonical.js";
import { parseBoundedUniqueJson } from "../../profile/templates/signing/json.js";
import { verifyEd25519Signature } from "../../profile/templates/signing/verify.js";
import { compareTemplateVersions } from "../../profile/templates/registry.js";
import { loadAcceptedIndex } from "../../profile/templates/taps/evidence.js";
import { readConfinedLeaf } from "../../utils/confined-read.js";
import {
  parseCapabilityContractVersion, parseCapabilityId, parseProviderCoordinate,
  parseProviderId, parseSemanticVersion, parseSha256Digest,
} from "../ids.js";
import type {
  BackendIdV1, ProviderPinV1, SemanticVersionV1, Sha256Digest,
} from "../types.js";
import { verifyProviderTree } from "./archive.js";
import {
  authorizedProviderDirectoryRealPath, bindAuthorizedProviderChildDirectory,
  bindExistingAuthorizedProviderDirectory, providerClockNow, type AuthorizedProviderDirectory,
  type AuthorizedProviderPaths,
} from "./paths.js";
import { parseCapabilityProviderPackage, parseProviderPackageEnvelope, type CapabilityDescriptorV1, type CapabilityProviderPackageV1, type PlatformArtifactV1 } from "./protocol.js";
import { readProviderInstallState, readProviderSourcesState } from "./state-store.js";
import { providerPinDigest, providerPinsForPayload } from "./pin.js";
import type { ProviderInstallRecordV1, ProviderSourceState } from "./state-types.js";
import { snapshotProviderPin } from "./pin-snapshot.js";

const MAX_REVOCATION_EVIDENCE_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
declare const entrypointTokenBrand: unique symbol;
const entrypointTokens = new WeakMap<ProviderEntrypointTokenV1, ProviderEntrypointClaimV1>();

interface InstalledAuthority {
  readonly record: ProviderInstallRecordV1;
  readonly stateDigest: string;
  readonly localApproved: boolean;
}

interface RevocationAuthority {
  readonly evidence: "current" | "stale-accepted" | "not-applicable";
  readonly source?: ProviderSourceState;
  readonly sourceDigest?: string;
  readonly indexDigest?: string;
}

/** Host-accepted isolation backend suitable for one exact platform artifact. */
export interface ProviderIsolationBackendV1 {
  readonly backendId: BackendIdV1;
  readonly os: string;
  readonly architecture: string;
}

/** Host-only resolver dependencies; callers cannot provide a package path or version selector. */
export interface ProviderResolutionContextV1 {
  readonly paths: AuthorizedProviderPaths;
  readonly protocolVersions: readonly string[];
  readonly isolationBackends: readonly ProviderIsolationBackendV1[];
}

/** A process-local token with no serializable representation or caller-selected value. */
export interface ProviderEntrypointTokenV1 {
  readonly [entrypointTokenBrand]: true;
  toJSON(): never;
}

/** @internal Private launch identity consumed only by the runtime boundary. */
export interface ProviderEntrypointClaimV1 {
  readonly artifactDigest: Sha256Digest;
  readonly entrypointRelativePath: string;
}

/** Closed exact-pin result that carries no config, cache, or executable path. */
export type ProviderResolutionV1 =
  | {
      readonly kind: "resolved";
      readonly pin: ProviderPinV1;
      readonly artifactDigest: Sha256Digest;
      readonly entrypointToken: ProviderEntrypointTokenV1;
      readonly capability: CapabilityDescriptorV1;
      readonly installationSource: "builtin" | "signed-remote" | "local-development";
      readonly isolationBackendId: BackendIdV1;
      readonly revocationEvidence: "current" | "stale-accepted" | "not-applicable";
    }
  | {
      readonly kind: "unavailable";
      readonly pin: ProviderPinV1;
      readonly code: ProviderResolutionProblemCodeV1;
      readonly detail: string;
    };

export type ProviderResolutionProblemCodeV1 =
  | "provider-not-installed" | "provider-package-missing" | "provider-package-integrity-invalid"
  | "provider-signature-invalid"
  | "provider-revoked" | "provider-revocation-evidence-stale" | "provider-local-unverified"
  | "provider-host-incompatible" | "provider-protocol-incompatible" | "provider-platform-incompatible"
  | "provider-isolation-unavailable" | "provider-store-unavailable";

/** Exact capability-list request; it has no provider-ID-only or latest selector. */
export interface ProviderListRequestV1 {
  readonly pins: readonly ProviderPinV1[];
  readonly context: ProviderResolutionContextV1;
}

/** Ordered exact-pin capability list shared by later CLI, SDK, and MCP surfaces. */
export interface ProviderCapabilityListV1 {
  readonly resolutions: readonly ProviderResolutionV1[];
}

/** Resolve exactly one complete installed pin in the design-mandated refusal order. */
export async function resolveProviderPin(
  pin: ProviderPinV1,
  context: ProviderResolutionContextV1,
): Promise<ProviderResolutionV1> {
  const exactPin = snapshotProviderPin(pin);
  try {
    validatePin(exactPin);
    const authority = await installedAuthority(exactPin, context.paths);
    const revocation = await verifyCurrentRevocation(exactPin, authority.record, context.paths);
    const verified = await verifiedPackage(exactPin, authority.record, context.paths, revocation.source);
    const compatibility = compatiblePackage(verified.payload, verified.artifact, context);
    const capability = capabilityForPin(exactPin, verified.payload);
    verifyLocalDisposition(authority.record, authority.localApproved);
    await assertAuthorityCurrent(exactPin, authority, revocation, context.paths);
    return resolved(exactPin, authority.record, verified.artifact, capability, compatibility, revocation.evidence);
  } catch (error) {
    return refused(exactPin, error);
  }
}

/** Resolve caller-supplied complete pins in their declared order without discovery side effects. */
export async function listProviderCapabilities(
  request: ProviderListRequestV1,
): Promise<ProviderCapabilityListV1> {
  return Object.freeze({
    resolutions: Object.freeze(await Promise.all(request.pins.map((pin) => resolveProviderPin(pin, request.context)))),
  });
}

/** @internal Claim one opaque token exactly once at the runtime boundary. */
export function consumeProviderEntrypointToken(token: ProviderEntrypointTokenV1): ProviderEntrypointClaimV1 {
  const claim = entrypointTokens.get(token);
  if (!claim) throw new Error("provider entrypoint token is expired or already used");
  entrypointTokens.delete(token);
  return claim;
}

/** Verify all derivable pin identity fields before touching authoritative state. */
function validatePin(pin: ProviderPinV1) {
  try {
    const coordinate = parseProviderCoordinate(pin.coordinate);
    if (pin.schemaVersion !== 1 || coordinate.providerId !== parseProviderId(pin.providerId)
      || coordinate.providerVersion !== parseSemanticVersion(pin.providerVersion)
      || parseCapabilityId(pin.capabilityId) !== pin.capabilityId
      || parseCapabilityContractVersion(pin.capabilityContractVersion) !== pin.capabilityContractVersion) throw integrityError();
    for (const digest of [pin.packageDigest, pin.manifestDigest, pin.capabilitySchemaDigest]) parseSha256Digest(digest);
    return coordinate;
  } catch { throw integrityError(); }
}

/** Find only an authoritative install record keyed by the requested package digest. */
async function installedAuthority(pin: ProviderPinV1, paths: AuthorizedProviderPaths): Promise<InstalledAuthority> {
  let state;
  try { state = await readProviderInstallState(paths); } catch { throw storeError(); }
  const record = state.installs[pin.packageDigest];
  if (!record) throw problem("provider-not-installed", "the exact provider pin is not installed");
  if (record.coordinate !== pin.coordinate || record.providerId !== pin.providerId || record.providerVersion !== pin.providerVersion
    || record.manifestDigest !== pin.manifestDigest) throw integrityError();
  return {
    record, stateDigest: canonicalDigest(state),
    localApproved: state.localApprovals[record.packageDigest] !== undefined,
  };
}

/** Recheck present remote revocation authority without refreshing or contacting a TAP. */
async function verifyCurrentRevocation(
  pin: ProviderPinV1,
  record: ProviderInstallRecordV1,
  paths: AuthorizedProviderPaths,
): Promise<RevocationAuthority> {
  if (record.sourceType !== "signed-remote") return { evidence: "not-applicable" };
  const coordinate = parseProviderCoordinate(pin.coordinate);
  const source = await acceptedSource(paths, coordinate.tap);
  const index = await acceptedIndex(paths, source);
  if (source.publisherPins.coordinates[record.coordinate] !== record.packageDigest) throw integrityError();
  if (source.publisherPins.revokedPackages.includes(pin.packageDigest)
    || (record.publisherKeyId !== null && source.publisherPins.revokedPublisherKeys.includes(record.publisherKeyId))) {
    throw problem("provider-revoked", "current accepted revocation evidence rejects this provider");
  }
  if (Date.parse(index.generatedAt) + MAX_REVOCATION_EVIDENCE_AGE_MS < providerNow(paths)) {
    throw problem("provider-revocation-evidence-stale", "accepted revocation evidence is older than seven days");
  }
  const evidence = Date.parse(index.expiresAt) <= providerNow(paths) ? "stale-accepted" : "current";
  return { evidence, source, sourceDigest: canonicalDigest(source), indexDigest: canonicalDigest(index) };
}

/** Require Task 3's separate exact approval for an installed local snapshot. */
function verifyLocalDisposition(record: ProviderInstallRecordV1, approved: boolean): void {
  if (record.sourceType !== "local-development") return;
  if (!approved) throw problem("provider-local-unverified", "local provider bytes require explicit execution approval");
}

/**
 * The pin digests every INSTALLED provider offers, one per declared capability.
 *
 * A pack names providers by PIN digest while installed state records PACKAGE
 * identity; those are digests over different values, so a surface comparing them
 * directly reports every correctly installed provider as absent. This derives
 * the pins the installed packages actually offer, so the comparison means
 * something.
 *
 * IT FAILS CLOSED PER RECORD. An install whose evidence cannot be read or
 * verified contributes NOTHING rather than aborting the enumeration: a readiness
 * report that cannot confirm one package should still describe the rest, and an
 * unreadable package is not evidence that a provider is available.
 *
 * It is a REPORTING aid, not an authorization: `resolveProviderPin` remains the
 * only path that decides whether a provider may actually execute.
 */
export async function installedProviderPinDigests(
  paths: AuthorizedProviderPaths,
): Promise<ReadonlySet<string>> {
  const digests = new Set<string>();
  const state = await readProviderInstallState(paths);
  for (const record of Object.values(state.installs)) {
    try {
      const coordinate = parseProviderCoordinate(record.coordinate);
      const source = record.sourceType === "signed-remote"
        ? await acceptedSource(paths, coordinate.tap) : undefined;
      const directory = await packageDirectory(paths, record.packageDigest);
      const payload = await readPackageEvidence(paths, directory, record, source);
      for (const pin of providerPinsForPayload(
        payload as unknown as Record<string, unknown>, record.coordinate, record.packageDigest,
      )) {
        digests.add(providerPinDigest(pin));
      }
    } catch { continue; }
  }
  return digests;
}

/** Load current signed TAP authority without turning resolver status into a refresh. */
async function acceptedSource(paths: AuthorizedProviderPaths, tap: string) {
  try {
    const source = (await readProviderSourcesState(paths)).sources[tap];
    if (!source || !source.enabled) throw storeError();
    return source;
  } catch { throw storeError(); }
}

/** Reverify the exact accepted cache index and redact all storage-level errors. */
async function acceptedIndex(paths: AuthorizedProviderPaths, source: Awaited<ReturnType<typeof acceptedSource>>) {
  try { return await loadAcceptedIndex(tapPaths(paths), source); } catch { throw storeError(); }
}

/** Reconstruct the TAP cache layout without accepting any caller-supplied filesystem authority. */
function tapPaths(paths: AuthorizedProviderPaths) {
  return { configRoot: paths.configRoot, cacheRoot: paths.providerCacheRoot, stateFile: paths.sourcesFile, lockFile: paths.lockFile };
}

/** Obtain the host clock from authorized Task 3 roots without trusting a caller timestamp. */
function providerNow(paths: AuthorizedProviderPaths): number {
  return providerClockNow(paths).getTime();
}

/** Fail closed when install or revocation authority drifts during resolution. */
async function assertAuthorityCurrent(
  pin: ProviderPinV1,
  authority: InstalledAuthority,
  revocation: RevocationAuthority,
  paths: AuthorizedProviderPaths,
): Promise<void> {
  const installs = await readProviderInstallState(paths).catch(() => { throw storeError(); });
  if (canonicalDigest(installs) !== authority.stateDigest) throw storeError();
  if (!revocation.source) return;
  const tap = parseProviderCoordinate(pin.coordinate).tap;
  const source = await acceptedSource(paths, tap);
  const index = await acceptedIndex(paths, source);
  if (canonicalDigest(source) !== revocation.sourceDigest
    || canonicalDigest(index) !== revocation.indexDigest) throw storeError();
}

/** Reverify digest-addressed tree bytes, evidence, and the package contract before use. */
async function verifiedPackage(
  pin: ProviderPinV1,
  record: ProviderInstallRecordV1,
  paths: AuthorizedProviderPaths,
  source: ProviderSourceState | undefined,
): Promise<{ payload: CapabilityProviderPackageV1; artifact: PlatformArtifactV1 }> {
  try {
    const directory = await packageDirectory(paths, pin.packageDigest);
    const payload = await readPackageEvidence(paths, directory, record, source);
    const artifact = artifactForRecord(payload, record);
    const tree = await bindAuthorizedProviderChildDirectory(paths, directory, path.join(directory.path, "tree"));
    await verifyProviderTree(tree.path, artifact, { expectedRootReal: await authorizedProviderDirectoryRealPath(paths, tree) });
    verifyPackageIdentity(pin, record, payload);
    return { payload, artifact };
  } catch (error) {
    if (error instanceof ResolutionError) throw error;
    throw integrityError();
  }
}

/** Bind a present digest cache directory without creating cache state during resolution. */
async function packageDirectory(paths: AuthorizedProviderPaths, digest: Sha256Digest): Promise<AuthorizedProviderDirectory> {
  const packages = await bindExistingAuthorizedProviderDirectory(paths, paths.packagesRoot).catch(() => { throw packageMissing(); });
  return bindAuthorizedProviderChildDirectory(paths, packages, path.join(packages.path, digest.slice(7))).catch(() => { throw packageMissing(); });
}

/** Parse the package evidence format selected at installation without exposing its leaf path. */
async function readPackageEvidence(
  paths: AuthorizedProviderPaths,
  directory: AuthorizedProviderDirectory,
  record: ProviderInstallRecordV1,
  source: ProviderSourceState | undefined,
): Promise<CapabilityProviderPackageV1> {
  const read = await readConfinedLeaf(directory.path, path.join(directory.path, "package.json"), directory.path, 4 * 1024 * 1024);
  if (read.kind !== "ok") throw integrityError();
  const value = parseBoundedUniqueJson(read.body, 4 * 1024 * 1024);
  if (record.sourceType !== "signed-remote") return parseCapabilityProviderPackage(value);
  const envelope = parseProviderPackageEnvelope(read.body);
  verifySignedInstallEvidence(envelope, record, source);
  return envelope.payload;
}

/** Reverify retained signed bytes with the exact publisher key preserved by TAP continuity. */
function verifySignedInstallEvidence(
  envelope: ReturnType<typeof parseProviderPackageEnvelope>,
  record: ProviderInstallRecordV1,
  source: ProviderSourceState | undefined,
): void {
  const coordinate = parseProviderCoordinate(envelope.coordinate);
  if (!source || record.publisherKeyId === null || coordinate.coordinate !== record.coordinate
    || envelope.payloadDigest !== record.packageDigest) throw integrityError();
  const key = source.publisherPins.keyHistory[record.publisherKeyId];
  if (!key || key.publisher !== coordinate.publisher) throw integrityError();
  const claim = canonicalBytes(packageClaim(envelope.coordinate, envelope.payloadDigest));
  try {
    verifyEd25519Signature(claim, envelope.publisherSignature, {
      keyId: record.publisherKeyId, publicKey: key.publicKey,
    }, "provider-publisher-signature");
  } catch { throw signatureError(); }
}

/** Select the exact artifact recorded at installation, never an implicit host fallback. */
function artifactForRecord(payload: CapabilityProviderPackageV1, record: ProviderInstallRecordV1): PlatformArtifactV1 {
  const artifact = payload.artifacts.find((candidate) => candidate.artifactId === record.artifactId);
  if (!artifact || artifact.artifactDigest !== record.artifactDigest || artifact.expandedTreeDigest !== record.expandedTreeDigest) throw integrityError();
  return artifact;
}

/** Bind signed package and manifest identity assertions to the exact installation record. */
function verifyPackageIdentity(pin: ProviderPinV1, record: ProviderInstallRecordV1, payload: CapabilityProviderPackageV1): void {
  if (canonicalDigest(payload) !== pin.packageDigest || canonicalDigest(payload.manifest) !== pin.manifestDigest
    || payload.providerId !== pin.providerId || payload.providerVersion !== pin.providerVersion
    || record.packageDigest !== pin.packageDigest) throw integrityError();
}

/** Select only the capability whose complete contract identity agrees with the pin. */
function capabilityForPin(pin: ProviderPinV1, payload: CapabilityProviderPackageV1): CapabilityDescriptorV1 {
  const capability = payload.manifest.capabilities.find((candidate) => candidate.capabilityId === pin.capabilityId);
  const schemaDigest = capability && canonicalDigest({
    inputSchema: capability.inputSchema, outputSchema: capability.outputSchema,
    progressSchema: capability.progressSchema ?? null, brokerRequirements: capability.brokerRequirements,
    artifactOutputs: capability.artifactOutputs,
  });
  if (!capability || capability.contractVersion !== pin.capabilityContractVersion || schemaDigest !== pin.capabilitySchemaDigest) throw integrityError();
  return capability;
}

/** Check host, protocol, platform, and accepted backend compatibility after integrity passes. */
function compatiblePackage(
  payload: CapabilityProviderPackageV1,
  artifact: PlatformArtifactV1,
  context: ProviderResolutionContextV1,
): ProviderIsolationBackendV1 {
  if (compareTemplateVersions(packageJson.version as SemanticVersionV1, payload.minLlmwikiVersion) < 0) throw problem("provider-host-incompatible", "the host version is outside the provider contract");
  if (!payload.manifest.protocolVersions.some((version) => context.protocolVersions.includes(version))) throw problem("provider-protocol-incompatible", "the host and provider have no common protocol");
  if (artifact.os !== process.platform || artifact.architecture !== process.arch) {
    throw problem("provider-platform-incompatible", "the installed provider artifact does not match the host platform");
  }
  const backend = [...context.isolationBackends].sort((left, right) => String(left.backendId).localeCompare(String(right.backendId)))
    .find((candidate) => candidate.os === process.platform && candidate.architecture === process.arch);
  if (!backend) throw problem("provider-isolation-unavailable", "no accepted isolation backend supports this provider platform");
  return backend;
}

/** Produce a closed resolved DTO and retain the actual launch binding only in process memory. */
function resolved(
  pin: ProviderPinV1,
  record: ProviderInstallRecordV1,
  artifact: PlatformArtifactV1,
  capability: CapabilityDescriptorV1,
  backend: ProviderIsolationBackendV1,
  revocationEvidence: "current" | "stale-accepted" | "not-applicable",
): ProviderResolutionV1 {
  const entrypointToken = tokenFor({ artifactDigest: artifact.artifactDigest, entrypointRelativePath: artifact.entrypointRelativePath });
  return Object.freeze({ kind: "resolved", pin, artifactDigest: artifact.artifactDigest, entrypointToken, capability, installationSource: record.sourceType, isolationBackendId: backend.backendId, revocationEvidence });
}

/** Mint one private object token whose JSON representation always refuses. */
function tokenFor(claim: ProviderEntrypointClaimV1): ProviderEntrypointTokenV1 {
  const token = Object.freeze({ toJSON: () => { throw new Error("provider entrypoint token is not serializable"); } }) as ProviderEntrypointTokenV1;
  entrypointTokens.set(token, Object.freeze(claim));
  return token;
}

/** Convert an internal stage failure into a bounded public unavailable result. */
function refused(pin: ProviderPinV1, error: unknown): ProviderResolutionV1 {
  const failure = error instanceof ResolutionError ? error : storeError();
  return Object.freeze({ kind: "unavailable", pin, code: failure.code, detail: failure.detail });
}

/** Construct one bounded typed refusal without preserving raw filesystem failures. */
function problem(code: ProviderResolutionProblemCodeV1, detail: string): ResolutionError {
  return new ResolutionError(code, detail);
}

/** Represent a deterministic resolver stage refusal without leaking raw causes. */
class ResolutionError extends Error {
  constructor(readonly code: ProviderResolutionProblemCodeV1, readonly detail: string) { super(detail); }
}

/** Return the stable missing-cache refusal. */
function packageMissing(): ResolutionError { return problem("provider-package-missing", "immutable provider bytes are unavailable"); }
/** Return the stable failed-integrity refusal. */
function integrityError(): ResolutionError { return problem("provider-package-integrity-invalid", "provider integrity verification failed"); }
/** Return the stable invalid-signature refusal without exposing key material. */
function signatureError(): ResolutionError { return problem("provider-signature-invalid", "provider signature verification failed"); }
/** Return the stable unavailable-authority refusal. */
function storeError(): ResolutionError { return problem("provider-store-unavailable", "provider authority state is unavailable"); }
