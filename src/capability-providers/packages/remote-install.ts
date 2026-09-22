/**
 * @file src/capability-providers/packages/remote-install.ts
 * @description Explicit signed provider source refresh and immutable remote
 * installation. It composes TAP continuity and same-origin confined fetch; no
 * downloaded provider byte is imported, probed, or executed.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import packageJson from "../../../package.json" with { type: "json" };
import { confinedFetch, type ConfinedFetchSeams } from "../../connectors/confined-fetch.js";
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import { advancePublisherPins, emptyPublisherPinState } from "../../profile/templates/signing/continuity.js";
import { parseSignedTapIndex, sha256DigestHex } from "../../profile/templates/signing/protocol.js";
import type { ParsedTapIndex } from "../../profile/templates/signing/protocol.js";
import type { PublisherKey } from "../../profile/templates/signing/types.js";
import {
  assertEd25519PublicKey, verifyAcceptedTapIndex, verifyTapIndex, verifyTapKeyRotation,
  type VerifiedTapIndex,
} from "../../profile/templates/signing/verify.js";
import { readIndexCache, writeIndexCache } from "../../profile/templates/taps/cache.js";
import { assertContinuityMatchesIndex, loadAcceptedIndex } from "../../profile/templates/taps/evidence.js";
import type { TapPaths } from "../../profile/templates/taps/paths.js";
import type { TapSourceState } from "../../profile/templates/taps/state-types.js";
import { MAX_COMPRESSED_PLATFORM_ARTIFACT_BYTES, MAX_SIGNED_PROVIDER_ENVELOPE_BYTES } from "../constants.js";
import { parseProviderCoordinate, parseSha256Digest } from "../ids.js";
import type { Sha256Digest } from "../types.js";
import {
  publishArchiveProviderLocked, type InstalledProviderSnapshot,
} from "./builtin.js";
import {
  assertAuthorizedProviderDirectory, assertAuthorizedProviderPaths,
  ensureAuthorizedProviderDirectory, providerClockNow, type AuthorizedProviderDirectory,
  type AuthorizedProviderPaths,
} from "./paths.js";
import { parseProviderPackageEnvelope, selectHostPlatformArtifact } from "./protocol.js";
import { readProviderSourcesState, withProviderStateLock, writeProviderSourcesState } from "./state-store.js";
import { verifyAcceptedProviderDistribution } from "./verify.js";

const INDEX_LIMITS = limits(4 * 1024 * 1024, ["application/json"]);
const PACKAGE_LIMITS = limits(MAX_SIGNED_PROVIDER_ENVELOPE_BYTES, ["application/json"]);
const ARTIFACT_LIMITS = limits(MAX_COMPRESSED_PLATFORM_ARTIFACT_BYTES, ["application/octet-stream"]);
const SOURCE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface AddProviderSourceRequest {
  readonly name: string;
  readonly indexUrl: string;
  readonly trustedKey: PublisherKey;
}

export interface RefreshProviderSourceOptions {
  readonly seams?: ConfinedFetchSeams;
}

export interface InstallRemoteProviderRequest {
  readonly coordinate: string;
  readonly confirmedPackageDigest: string;
  readonly confirmedIndexDigest: string;
  readonly seams?: ConfinedFetchSeams;
  readonly afterPublicationForTest?: (treePath: string) => Promise<void>;
  readonly afterDownloadParentCheckForTest?: (directory: string) => Promise<void>;
  readonly afterDownloadOpenForTest?: (leaf: string) => Promise<void>;
  readonly afterInstallStateCommitForTest?: (directory: string) => Promise<void>;
}

/** Add or re-enable exactly one retained signed provider source identity. */
export async function addProviderSource(
  paths: AuthorizedProviderPaths,
  request: AddProviderSourceRequest,
): Promise<TapSourceState> {
  const proposed = newSource(request);
  return withProviderStateLock(paths, async () => {
    const state = await readProviderSourcesState(paths);
    const existing = state.sources[proposed.name];
    if (existing) assertSameSource(existing, proposed);
    const next = Object.freeze(existing ? { ...existing, enabled: true } : proposed);
    await writeProviderSourcesState(paths, {
      schemaVersion: 1, sources: Object.freeze({ ...state.sources, [next.name]: next }),
    });
    return next;
  });
}

/** Refresh and durably accept one provider TAP snapshot. */
export async function refreshProviderSource(
  paths: AuthorizedProviderPaths,
  name: string,
  options: RefreshProviderSourceOptions = {},
): Promise<{ source: string; sequence: number; packages: number }> {
  return refreshProviderSourceInternal(paths, name, options, false);
}

async function refreshProviderSourceInternal(
  paths: AuthorizedProviderPaths,
  name: string,
  options: RefreshProviderSourceOptions,
  acceptCurrentSequence: boolean,
): Promise<{ source: string; sequence: number; packages: number }> {
  if (!SOURCE_SLUG.test(name)) throw new Error("provider source name is invalid");
  const initial = (await readProviderSourcesState(paths)).sources[name];
  if (!initial || !initial.enabled) throw new Error("provider source is unavailable or disabled");
  const now = providerClockNow(paths);
  const text = strictUtf8(await fetchExact(initial.indexUrl, initial, INDEX_LIMITS, options.seams));
  const parsed = parseSignedTapIndex(text);
  if (parsed.sequence === initial.publisherPins.highestSequence) {
    return repairAcceptedIndex(paths, initial, parsed, text, now, acceptCurrentSequence);
  }
  const key = acceptedTapKey(initial, parsed);
  const verified = verifyTapIndex(parsed, name, key, now);
  const pins = advancePublisherPins(verified, initial.publisherPins);
  const next = nextSource(initial, key, pins, canonicalDigest(parsed) as Sha256Digest);
  await commitRefresh(paths, initial, next, text);
  return { source: name, sequence: verified.sequence, packages: verified.packages.length };
}

/** Download, reverify, extract, and record one exact signed provider package. */
export async function installRemoteProvider(
  paths: AuthorizedProviderPaths,
  request: InstallRemoteProviderRequest,
): Promise<InstalledProviderSnapshot> {
  const coordinate = parseProviderCoordinate(request.coordinate);
  await refreshProviderSourceInternal(paths, coordinate.tap, {
    seams: request.seams,
  }, true);
  const initial = (await readProviderSourcesState(paths)).sources[coordinate.tap];
  if (!initial || !initial.enabled) throw new Error("provider source is unavailable or disabled");
  const index = await freshConfirmedIndex(paths, initial, request);
  const envelopeText = strictUtf8(await fetchPackage(
    paths, initial, index, request.coordinate, request.seams,
    request.afterDownloadParentCheckForTest, request.afterDownloadOpenForTest,
  ));
  const envelope = parseProviderPackageEnvelope(envelopeText);
  const verified = verifyAcceptedProviderDistribution({
    envelope, index, pins: initial.publisherPins, currentVersion: packageJson.version,
  });
  if (request.confirmedPackageDigest !== envelope.payloadDigest) {
    throw new Error("provider confirmation does not match the verified package digest");
  }
  const artifact = selectHostPlatformArtifact(verified.payload);
  const archive = await fetchArtifact(paths, initial, artifact.artifactDigest, artifact.archiveFormat, request.seams);
  return commitInstall(paths, initial, request, envelopeText, archive, artifact);
}

async function commitInstall(
  paths: AuthorizedProviderPaths,
  initial: TapSourceState,
  request: InstallRemoteProviderRequest,
  envelopeText: string,
  archive: Buffer,
  artifact: ReturnType<typeof selectHostPlatformArtifact>,
): Promise<InstalledProviderSnapshot> {
  return withProviderStateLock(paths, async () => {
    const current = (await readProviderSourcesState(paths)).sources[initial.name];
    if (!current || canonicalDigest(current) !== canonicalDigest(initial)) throw new Error("provider source changed during install; retry");
    const index = await freshConfirmedIndex(paths, current, request);
    const envelope = parseProviderPackageEnvelope(envelopeText);
    const verified = verifyAcceptedProviderDistribution({
      envelope, index, pins: current.publisherPins, currentVersion: packageJson.version,
    });
    return publishArchiveProviderLocked(paths, {
      payload: verified.payload, artifact, archive,
      packageDigest: envelope.payloadDigest, coordinate: envelope.coordinate,
      sourceType: "signed-remote", packageEvidenceText: envelopeText,
      tapSequence: index.sequence, publisherKeyId: verified.publisherKeyId,
      acceptedIndexDigest: current.acceptedIndexDigest as Sha256Digest,
      installedAt: providerClockNow(paths),
      afterPublicationForTest: request.afterPublicationForTest,
      afterInstallStateCommitForTest: request.afterInstallStateCommitForTest,
    });
  });
}

async function repairAcceptedIndex(
  paths: AuthorizedProviderPaths,
  source: TapSourceState,
  parsed: ParsedTapIndex,
  text: string,
  now: Date | undefined,
  acceptCurrentSequence: boolean,
): Promise<{ source: string; sequence: number; packages: number }> {
  verifyTapIndex(parsed, source.name, source.currentTapKey, now);
  if (canonicalDigest(parsed) !== source.acceptedIndexDigest) throw new Error("provider index fork differs from accepted evidence");
  try {
    await acceptedIndex(paths, source);
    if (!acceptCurrentSequence) throw new Error("provider index sequence rollback or replay");
    return { source: source.name, sequence: parsed.sequence, packages: parsed.packages.length };
  } catch (error) {
    if ((error as Error).message.includes("rollback or replay")) throw error;
  }
  const verified = verifyAcceptedTapIndex(parsed, source.name, source.currentTapKey, source.publisherPins);
  assertContinuityMatchesIndex(verified, source);
  await withProviderStateLock(paths, async () => {
    await assertSourceUnchanged(paths, source);
    await writeIndexCache(cachePaths(paths), source.name, parsed.sequence, text);
  });
  return { source: source.name, sequence: parsed.sequence, packages: parsed.packages.length };
}

async function commitRefresh(
  paths: AuthorizedProviderPaths,
  initial: TapSourceState,
  next: TapSourceState,
  text: string,
): Promise<void> {
  await withProviderStateLock(paths, async () => {
    const state = await readProviderSourcesState(paths);
    const current = state.sources[initial.name];
    if (!current || canonicalDigest(current) !== canonicalDigest(initial)) throw new Error("provider source changed during refresh; retry");
    await writeIndexCache(cachePaths(paths), next.name, next.publisherPins.highestSequence, text);
    await assertAuthorizedProviderPaths(paths);
    await writeProviderSourcesState(paths, {
      schemaVersion: 1, sources: Object.freeze({ ...state.sources, [next.name]: next }),
    });
  });
}

async function acceptedIndex(paths: AuthorizedProviderPaths, source: TapSourceState): Promise<VerifiedTapIndex> {
  await assertAuthorizedProviderPaths(paths);
  const index = await loadAcceptedIndex(cachePaths(paths), source);
  await assertAuthorizedProviderPaths(paths);
  return index;
}

async function freshConfirmedIndex(
  paths: AuthorizedProviderPaths,
  source: TapSourceState,
  request: Pick<InstallRemoteProviderRequest, "confirmedIndexDigest">,
): Promise<VerifiedTapIndex> {
  const confirmed = parseSha256Digest(request.confirmedIndexDigest);
  const index = await acceptedIndex(paths, source);
  const fresh = verifyTapIndex(index, source.name, source.currentTapKey, providerClockNow(paths));
  if (canonicalDigest(fresh) !== confirmed) throw new Error("provider index confirmation differs from accepted evidence");
  return fresh;
}

async function fetchPackage(
  paths: AuthorizedProviderPaths,
  source: TapSourceState,
  index: VerifiedTapIndex,
  coordinate: string,
  seams?: ConfinedFetchSeams,
  afterParentCheckForTest?: (directory: string) => Promise<void>,
  afterOpenForTest?: (leaf: string) => Promise<void>,
): Promise<Buffer> {
  const entry = index.packages.find((candidate) => candidate.coordinate === coordinate);
  if (!entry) throw new Error("provider coordinate is absent from the accepted index");
  const bytes = await fetchExact(contentUrl(source.indexUrl, "packages", entry.payloadDigest, "json"), source, PACKAGE_LIMITS, seams);
  return custodyDownload(paths, bytes, undefined, afterParentCheckForTest, afterOpenForTest);
}

async function fetchArtifact(
  paths: AuthorizedProviderPaths,
  source: TapSourceState,
  digest: string,
  format: "tar" | "zip",
  seams?: ConfinedFetchSeams,
): Promise<Buffer> {
  const bytes = await fetchExact(contentUrl(source.indexUrl, "artifacts", digest, format), source, ARTIFACT_LIMITS, seams);
  return custodyDownload(paths, bytes, digest);
}

async function custodyDownload(
  paths: AuthorizedProviderPaths,
  bytes: Buffer,
  expectedDigest?: string,
  afterParentCheckForTest?: (directory: string) => Promise<void>,
  afterOpenForTest?: (leaf: string) => Promise<void>,
): Promise<Buffer> {
  await assertAuthorizedProviderPaths(paths);
  const downloads = await ensureAuthorizedProviderDirectory(paths, paths.downloadsRoot);
  await afterParentCheckForTest?.(paths.downloadsRoot);
  await assertAuthorizedProviderDirectory(paths, downloads);
  const leaf = path.join(paths.downloadsRoot, `.download-${randomUUID()}`);
  await assertAuthorizedProviderDirectory(paths, downloads);
  const write = await open(leaf, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await afterOpenForTest?.(leaf);
    await assertDownloadLeafBound(paths, downloads, leaf, write);
    await write.writeFile(bytes); await write.sync();
    await assertDownloadLeafBound(paths, downloads, leaf, write);
  } finally {
    await write.close();
  }
  try {
    await assertAuthorizedProviderDirectory(paths, downloads);
    const read = await open(leaf, fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW));
    try {
      await assertDownloadLeafBound(paths, downloads, leaf, read);
      const observed = await read.readFile();
      if (expectedDigest && digestBytes(observed) !== expectedDigest) throw new Error("provider download digest differs from signed metadata");
      await assertDownloadLeafBound(paths, downloads, leaf, read);
      return observed;
    } finally {
      await read.close();
    }
  } finally {
    await assertAuthorizedProviderDirectory(paths, downloads);
    await unlink(leaf).catch(() => {});
  }
}

async function assertDownloadLeafBound(
  paths: AuthorizedProviderPaths,
  downloads: AuthorizedProviderDirectory,
  leaf: string,
  handle: FileHandle,
): Promise<void> {
  await assertAuthorizedProviderDirectory(paths, downloads);
  // Download custody and package-evidence custody remain separate trust seams.
  // fallow-ignore-next-line code-duplication
  const [opened, current] = await Promise.all([handle.stat(), lstat(leaf)]);
  if (!opened.isFile() || !current.isFile() || current.isSymbolicLink()
    || opened.dev !== current.dev || opened.ino !== current.ino) {
    throw new Error("provider download leaf changed or escaped its authorized parent");
  }
}

function digestBytes(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function fetchExact(
  url: string,
  source: TapSourceState,
  resourceLimits: ReturnType<typeof limits>,
  seams: ConfinedFetchSeams = {},
): Promise<Buffer> {
  const fetched = await confinedFetch(
    { url }, resourceLimits,
    { allowedHosts: [new URL(source.indexUrl).hostname], allowedOrigins: [source.origin] }, seams,
  );
  if (fetched.kind !== "ok") throw new Error(`provider download ${fetched.kind}: ${fetched.reason}`);
  return fetched.bytes;
}

function acceptedTapKey(source: TapSourceState, index: ParsedTapIndex): PublisherKey {
  if (index.signature.keyId === source.currentTapKey.keyId) return source.currentTapKey;
  const rotation = index.tapKeyRotation;
  if (!rotation || rotation.effectiveSequence !== index.sequence) throw new Error("provider TAP root changed without a valid rotation");
  if (source.retiredTapKeyIds.includes(rotation.toKey.keyId)) throw new Error("retired provider TAP root cannot be reused");
  return verifyTapKeyRotation(source.name, rotation, source.currentTapKey);
}

function nextSource(
  source: TapSourceState,
  key: PublisherKey,
  pins: TapSourceState["publisherPins"],
  digest: Sha256Digest,
): TapSourceState {
  const rotated = key.keyId !== source.currentTapKey.keyId;
  return Object.freeze({
    ...source, currentTapKey: key,
    retiredTapKeyIds: rotated ? [...source.retiredTapKeyIds, source.currentTapKey.keyId] : source.retiredTapKeyIds,
    acceptedIndexDigest: digest, publisherPins: pins,
  });
}

function newSource(request: AddProviderSourceRequest): TapSourceState {
  if (!SOURCE_SLUG.test(request.name)) throw new Error("provider source name is invalid");
  const url = providerIndexUrl(request.indexUrl);
  assertProviderTapKey(request.trustedKey);
  return Object.freeze({
    name: request.name, indexUrl: url.toString(), origin: url.origin, enabled: true,
    currentTapKey: request.trustedKey, retiredTapKeyIds: [], acceptedIndexDigest: null,
    publisherPins: emptyPublisherPinState(request.name),
  });
}

function providerIndexUrl(value: string): URL {
  const url = new URL(value);
  const clean = Buffer.byteLength(value) <= 2048 && url.protocol === "https:"
    && !url.username && !url.password && !url.search && !url.hash
    && url.pathname.endsWith("/index.json");
  if (!clean) throw new Error("provider index URL must be clean HTTPS ending in /index.json");
  return url;
}

function assertProviderTapKey(key: PublisherKey): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key.keyId) || Buffer.byteLength(key.publicKey) > 4096) {
    throw new Error("provider TAP key is invalid");
  }
  assertEd25519PublicKey(key);
}

// Provider source state deliberately validates independently from template TAP management.
// fallow-ignore-next-line code-duplication
function assertSameSource(existing: TapSourceState, proposed: TapSourceState): void {
  const same = existing.indexUrl === proposed.indexUrl && existing.origin === proposed.origin
    && existing.currentTapKey.keyId === proposed.currentTapKey.keyId
    && existing.currentTapKey.publicKey === proposed.currentTapKey.publicKey;
  if (!same) throw new Error("provider source trust identity cannot be replaced");
}

async function assertSourceUnchanged(paths: AuthorizedProviderPaths, expected: TapSourceState): Promise<void> {
  const current = (await readProviderSourcesState(paths)).sources[expected.name];
  if (!current || canonicalDigest(current) !== canonicalDigest(expected)) throw new Error("provider source changed; retry");
}

function contentUrl(indexUrl: string, kind: "packages" | "artifacts", digest: string, extension: string): string {
  const hex = sha256DigestHex(digest);
  return new URL(`${kind}/sha256/${hex}.${extension}`, new URL(".", indexUrl)).toString();
}

function cachePaths(paths: AuthorizedProviderPaths): TapPaths {
  return {
    configRoot: paths.configRoot, cacheRoot: paths.providerCacheRoot,
    stateFile: paths.sourcesFile, lockFile: paths.lockFile,
  };
}

function strictUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("provider JSON evidence is not valid UTF-8");
  }
}

function limits(maxBytes: number, contentTypes: readonly string[]) {
  return { timeoutMs: 15_000, maxBytes, maxTransportBytes: maxBytes, maxRedirects: 3, contentTypes };
}
