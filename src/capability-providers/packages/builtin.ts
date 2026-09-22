/**
 * @file src/capability-providers/packages/builtin.ts
 * @description Atomic publication shared by builtin and verified remote
 * provider archives. Publication only stores bytes and evidence; it never
 * imports, probes, or executes a provider entrypoint.
 */
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import { readConfinedLeaf } from "../../utils/confined-read.js";
import { MAX_SIGNED_PROVIDER_ENVELOPE_BYTES } from "../constants.js";
import type { Sha256Digest } from "../types.js";
import { extractProviderArchive, verifyProviderTree } from "./archive.js";
import {
  resolveBuiltinProviderRelease, type HostBuiltinProviderRelease,
} from "./builtin-release.js";
import {
  persistProviderInstall, type InstalledProviderSnapshot,
} from "./install-persistence.js";
import {
  assertAuthorizedProviderDirectory, assertAuthorizedProviderPaths,
  authorizedProviderDirectoryRealPath, bindAuthorizedProviderChildDirectory,
  ensureAuthorizedProviderDirectory, providerClockNow, setAuthorizedProviderDirectoryMode,
  type AuthorizedProviderDirectory,
  type AuthorizedProviderPaths,
} from "./paths.js";
import {
  parseCapabilityProviderPackage, selectHostPlatformArtifact,
  type CapabilityProviderPackageV1, type PlatformArtifactV1,
} from "./protocol.js";
import { readProviderInstallState, withProviderStateLock } from "./state-store.js";
import type { ProviderInstallRecordV1, ProviderInstallationSourceV1 } from "./state-types.js";
export type { InstalledProviderSnapshot } from "./install-persistence.js";

/** Internal verified bytes ready for publication while holding the state lock. */
export interface ArchivePublicationRequest {
  readonly payload: CapabilityProviderPackageV1;
  readonly artifact: PlatformArtifactV1;
  readonly archive: Buffer;
  readonly packageDigest: Sha256Digest;
  readonly coordinate: string;
  readonly sourceType: Exclude<ProviderInstallationSourceV1, "builtin">;
  readonly packageEvidenceText: string;
  readonly tapSequence: number | null;
  readonly publisherKeyId: string | null;
  readonly acceptedIndexDigest: Sha256Digest | null;
  readonly installedAt: Date;
  readonly afterPublicationForTest?: (treePath: string) => Promise<void>;
  readonly afterPackageParentCheckForTest?: (directory: string) => Promise<void>;
  readonly afterPackageStagingOpenForTest?: (directory: string) => Promise<void>;
  readonly afterStagingCheckBeforeTreeForTest?: (directory: string) => Promise<void>;
  readonly afterInstallStateCommitForTest?: (directory: string) => Promise<void>;
}

export type PreparedPublicationRequest = Omit<ArchivePublicationRequest, "archive">;
interface AuthorizedArchivePublicationRequest extends Omit<ArchivePublicationRequest, "sourceType"> {
  readonly sourceType: ProviderInstallationSourceV1;
}
type AuthorizedPreparedPublicationRequest = Omit<AuthorizedArchivePublicationRequest, "archive">;

/** Install release-provenance bytes through the same immutable package path. */
export async function installBuiltinProvider(
  paths: AuthorizedProviderPaths,
  release: HostBuiltinProviderRelease,
): Promise<InstalledProviderSnapshot> {
  const request = await resolveBuiltinProviderRelease(paths, release);
  return withProviderStateLock(paths, () => publishAuthorizedArchiveProviderLocked(paths, {
    payload: request.payload, artifact: request.artifact, archive: request.archive,
    packageDigest: request.packageDigest, coordinate: request.coordinate,
    sourceType: "builtin", packageEvidenceText: `${JSON.stringify(request.payload)}\n`,
    tapSequence: null, publisherKeyId: null, acceptedIndexDigest: null,
    installedAt: providerClockNow(paths),
    afterPackageParentCheckForTest: request.afterPackageParentCheckForTest,
    afterPackageStagingOpenForTest: request.afterPackageStagingOpenForTest,
    afterStagingCheckBeforeTreeForTest: request.afterStagingCheckBeforeTreeForTest,
  }));
}

/** @internal Publish already verified archive bytes under the held lock. */
export async function publishArchiveProviderLocked(
  paths: AuthorizedProviderPaths,
  request: ArchivePublicationRequest,
): Promise<InstalledProviderSnapshot> {
  assertNonBuiltinPublication(request.sourceType);
  return publishAuthorizedArchiveProviderLocked(paths, request);
}

async function publishAuthorizedArchiveProviderLocked(
  paths: AuthorizedProviderPaths,
  request: AuthorizedArchivePublicationRequest,
): Promise<InstalledProviderSnapshot> {
  const normalized = normalizePublicationRequest(request);
  return publishPreparedProviderCore(paths, normalized, (tree, expectedParentReal) => (
    extractProviderArchive(request.archive, normalized.artifact, tree, {
      expectedParentReal,
    }).then(() => undefined)
  ));
}

/** @internal Publish a host-prepared tree under the same immutable protocol. */
export async function publishPreparedProviderLocked(
  paths: AuthorizedProviderPaths,
  request: PreparedPublicationRequest,
  prepareTree: (tree: string, expectedParentReal: string) => Promise<void>,
): Promise<InstalledProviderSnapshot> {
  assertNonBuiltinPublication(request.sourceType);
  return publishPreparedProviderCore(paths, normalizePublicationRequest(request), prepareTree);
}

async function publishPreparedProviderCore(
  paths: AuthorizedProviderPaths,
  request: AuthorizedPreparedPublicationRequest,
  prepareTree: (tree: string, expectedParentReal: string) => Promise<void>,
): Promise<InstalledProviderSnapshot> {
  await assertAuthorizedProviderPaths(paths);
  assertPayloadDigest(request.payload, request.packageDigest);
  const existing = (await readProviderInstallState(paths)).installs[request.packageDigest];
  const proposed = installRecord(request);
  const record = preferredEvidence(existing, proposed);
  const destination = packageDirectory(paths, request.packageDigest);
  const packages = await ensureAuthorizedProviderDirectory(paths, paths.packagesRoot);
  await request.afterPackageParentCheckForTest?.(paths.packagesRoot);
  await assertAuthorizedProviderDirectory(paths, packages);
  const reused = await reuseInstalled(
    paths, packages, destination, request.artifact, request.packageEvidenceText, record,
    request.afterInstallStateCommitForTest,
  );
  if (reused) return reused;
  return publishNewSnapshot(paths, packages, destination, request, prepareTree, record);
}

async function publishNewSnapshot(
  paths: AuthorizedProviderPaths,
  packages: AuthorizedProviderDirectory,
  destination: string,
  request: AuthorizedPreparedPublicationRequest,
  prepareTree: (tree: string, expectedParentReal: string) => Promise<void>,
  record: ProviderInstallRecordV1,
): Promise<InstalledProviderSnapshot> {
  const staging = path.join(paths.packagesRoot, `.staging-${randomUUID()}`);
  try {
    await assertAuthorizedProviderDirectory(paths, packages);
    const stagingDirectory = await ensureAuthorizedProviderDirectory(paths, staging);
    await request.afterPackageStagingOpenForTest?.(staging);
    const stagingReal = await authorizedProviderDirectoryRealPath(paths, stagingDirectory);
    await request.afterStagingCheckBeforeTreeForTest?.(staging);
    await prepareTree(path.join(staging, "tree"), stagingReal);
    await assertAuthorizedProviderDirectory(paths, stagingDirectory);
    await writeEvidence(paths, stagingDirectory, request.packageEvidenceText);
    await assertAuthorizedProviderDirectory(paths, stagingDirectory);
    await assertAuthorizedProviderDirectory(paths, packages);
    await publishStaging(staging, destination);
    await assertAuthorizedProviderDirectory(paths, packages);
    const published = await bindAuthorizedProviderChildDirectory(paths, packages, destination);
    await setAuthorizedProviderDirectoryMode(paths, published, 0o500);
    await request.afterPublicationForTest?.(path.join(published.path, "tree"));
    const tree = await verifyPublishedProvider(
      paths, published, request.artifact, request.packageEvidenceText,
    );
    return persistProviderInstall(
      paths, published, tree, record, request.afterInstallStateCommitForTest,
    );
  } catch (error) {
    await assertAuthorizedProviderDirectory(paths, packages);
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    await discardIfInvalid(
      paths, packages, destination, request.artifact, request.packageEvidenceText,
    );
    throw error;
  }
}

async function reuseInstalled(
  paths: AuthorizedProviderPaths,
  packages: AuthorizedProviderDirectory,
  destination: string,
  artifact: PlatformArtifactV1,
  evidence: string,
  record: ProviderInstallRecordV1,
  afterCommit?: (directory: string) => Promise<void>,
): Promise<InstalledProviderSnapshot | null> {
  const cached = await bindOrRepairCacheDirectory(paths, packages, destination);
  if (!cached) return null;
  const tree = await reuseOrDiscard(paths, packages, cached, artifact, evidence);
  if (!tree) return null;
  return persistProviderInstall(paths, cached, tree, record, afterCommit);
}

function installRecord(request: AuthorizedPreparedPublicationRequest): ProviderInstallRecordV1 {
  return Object.freeze({
    packageDigest: request.packageDigest, coordinate: request.coordinate as ProviderInstallRecordV1["coordinate"],
    providerId: request.payload.providerId, providerVersion: request.payload.providerVersion,
    manifestDigest: canonicalDigest(request.payload.manifest) as Sha256Digest,
    artifactId: request.artifact.artifactId, artifactDigest: request.artifact.artifactDigest,
    expandedTreeDigest: request.artifact.expandedTreeDigest, sourceType: request.sourceType,
    installedAt: request.installedAt.toISOString(), tapSequence: request.tapSequence,
    publisherKeyId: request.publisherKeyId, acceptedIndexDigest: request.acceptedIndexDigest,
  });
}

function preferredEvidence(
  existing: ProviderInstallRecordV1 | undefined,
  proposed: ProviderInstallRecordV1,
): ProviderInstallRecordV1 {
  if (!existing) return proposed;
  const sameInstallation = { ...proposed, installedAt: existing.installedAt };
  return canonicalDigest(existing) === canonicalDigest(sameInstallation) ? existing : proposed;
}

async function writeEvidence(
  paths: AuthorizedProviderPaths,
  staging: AuthorizedProviderDirectory,
  text: string,
): Promise<void> {
  if (Buffer.byteLength(text) > MAX_SIGNED_PROVIDER_ENVELOPE_BYTES) throw new Error("provider package evidence exceeds its byte cap");
  const leaf = path.join(staging.path, "package.json");
  const handle = await open(leaf, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o400);
  try {
    await assertLeafBound(paths, staging, leaf, handle);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await assertLeafBound(paths, staging, leaf, handle);
  } finally {
    await handle.close();
  }
}

async function assertLeafBound(
  paths: AuthorizedProviderPaths,
  directory: AuthorizedProviderDirectory,
  leaf: string,
  handle: FileHandle,
): Promise<void> {
  await assertAuthorizedProviderDirectory(paths, directory);
  const [opened, current] = await Promise.all([handle.stat(), lstat(leaf)]);
  if (!opened.isFile() || !current.isFile() || current.isSymbolicLink()
    || opened.dev !== current.dev || opened.ino !== current.ino) {
    throw new Error("provider package evidence changed or escaped its authorized parent");
  }
}

async function publishStaging(staging: string, destination: string): Promise<void> {
  await syncDirectory(staging);
  try {
    await rename(staging, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
  const entry = await lstat(destination);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("provider package cache destination is unavailable");
  }
  await syncDirectory(path.dirname(destination));
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function bindOrRepairCacheDirectory(
  paths: AuthorizedProviderPaths,
  packages: AuthorizedProviderDirectory,
  directory: string,
): Promise<AuthorizedProviderDirectory | null> {
  if (path.dirname(directory) !== packages.path) throw new Error("provider package cache path is invalid");
  await assertAuthorizedProviderDirectory(paths, packages);
  const entry = await lstat(directory).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (entry === null) return null;
  if (entry.isDirectory() && !entry.isSymbolicLink()) {
    return bindAuthorizedProviderChildDirectory(paths, packages, directory);
  }
  await rm(directory, { force: true });
  await assertAuthorizedProviderDirectory(paths, packages);
  return null;
}

async function reuseOrDiscard(
  paths: AuthorizedProviderPaths,
  packages: AuthorizedProviderDirectory,
  directory: AuthorizedProviderDirectory,
  artifact: PlatformArtifactV1,
  evidence: string,
): Promise<AuthorizedProviderDirectory | null> {
  try {
    return await verifyPublishedProvider(paths, directory, artifact, evidence);
  } catch {
    await discardCacheDirectory(paths, packages, directory);
    return null;
  }
}

async function discardIfInvalid(
  paths: AuthorizedProviderPaths,
  packages: AuthorizedProviderDirectory,
  destination: string,
  artifact: PlatformArtifactV1,
  evidence: string,
): Promise<void> {
  const directory = await bindOrRepairCacheDirectory(paths, packages, destination);
  if (!directory) return;
  try {
    await verifyPublishedProvider(paths, directory, artifact, evidence);
  } catch {
    await discardCacheDirectory(paths, packages, directory);
  }
}

async function verifyPublishedProvider(
  paths: AuthorizedProviderPaths,
  directory: AuthorizedProviderDirectory,
  artifact: PlatformArtifactV1,
  evidence: string,
): Promise<AuthorizedProviderDirectory> {
  const treePath = path.join(directory.path, "tree");
  const tree = await bindAuthorizedProviderChildDirectory(paths, directory, treePath);
  const treeReal = await authorizedProviderDirectoryRealPath(paths, tree);
  await verifyProviderTree(treePath, artifact, {
    expectedRootReal: treeReal,
  });
  await assertAuthorizedProviderDirectory(paths, directory);
  const leaf = path.join(directory.path, "package.json");
  const observed = await readConfinedLeaf(
    directory.path, leaf, directory.path, MAX_SIGNED_PROVIDER_ENVELOPE_BYTES,
  );
  if (observed.kind !== "ok" || observed.body !== evidence) {
    throw new Error("provider package evidence differs from verified installation evidence");
  }
  await assertAuthorizedProviderDirectory(paths, directory);
  await assertAuthorizedProviderDirectory(paths, tree);
  return tree;
}

async function discardCacheDirectory(
  paths: AuthorizedProviderPaths,
  packages: AuthorizedProviderDirectory,
  directory: AuthorizedProviderDirectory,
): Promise<void> {
  const destination = directory.path;
  if (path.dirname(destination) !== paths.packagesRoot) throw new Error("provider package cache path is invalid");
  await assertAuthorizedProviderDirectory(paths, directory);
  await assertAuthorizedProviderDirectory(paths, packages);
  await thawDirectories(destination);
  await assertAuthorizedProviderDirectory(paths, packages);
  await rm(destination, { recursive: true, force: true });
  await assertAuthorizedProviderDirectory(paths, packages);
}

async function thawDirectories(directory: string): Promise<void> {
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("provider package cache destination is unavailable");
  if (process.platform !== "win32") await chmod(directory, 0o700);
  for (const child of await readdir(directory, { withFileTypes: true })) {
    if (child.isDirectory() && !child.isSymbolicLink()) await thawDirectories(path.join(directory, child.name));
  }
}

function packageDirectory(paths: AuthorizedProviderPaths, digest: Sha256Digest): string {
  const hex = /^sha256:([0-9a-f]{64})$/.exec(digest)?.[1];
  if (!hex) throw new Error("provider package digest is invalid");
  return path.join(paths.packagesRoot, hex);
}

function normalizePublicationRequest(
  request: AuthorizedPreparedPublicationRequest,
): AuthorizedPreparedPublicationRequest {
  const payload = parseCapabilityProviderPackage(request.payload);
  const artifact = selectHostPlatformArtifact(payload);
  if (canonicalDigest(artifact) !== canonicalDigest(request.artifact)) {
    throw new Error("provider publication artifact differs from the host package artifact");
  }
  return { ...request, payload, artifact };
}

function assertNonBuiltinPublication(source: ProviderInstallationSourceV1): void {
  if (source === "builtin") throw new Error("host-owned builtin release authority is required");
  if (source !== "signed-remote" && source !== "local-development") {
    throw new Error("provider installation source is invalid");
  }
}

function assertPayloadDigest(payload: CapabilityProviderPackageV1, digest: Sha256Digest): void {
  if (canonicalDigest(payload) !== digest) throw new Error("provider package digest differs from payload bytes");
}
