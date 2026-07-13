/**
 * @file src/profile/templates/status.ts
 * @description Read-only template provenance and profile-drift status.
 * Advisory lock fields locate a release; independently resolved release bytes
 * determine whether the active profile matches what was installed.
 */
import { profileDigest } from "../digest.js";
import { journalHealth } from "../../trust/journal-health.js";
import { loadProfile } from "../load.js";
import { getBuiltinTemplate } from "./registry.js";
import { compareTemplateVersions } from "./registry.js";
import { readTemplateLock, type TemplateLockRead } from "./lock.js";
import { parseTemplateCoordinate } from "./signing/protocol.js";
import { remoteCoordinateFromLock } from "./remote-lifecycle.js";
import { loadAcceptedIndex } from "./taps/evidence.js";
import { resolveRemotePackage } from "./taps/package.js";
import { resolveTapPaths, type TapPaths } from "./taps/paths.js";
import { readTapState } from "./taps/state-store.js";
import type { TapSourceState } from "./taps/state-types.js";
import type { ProfileTemplatePackage, TemplateLock, TemplateLockV2, TemplateSourceType } from "./types.js";

export type TemplateStatusKind =
  | "untracked"
  | "installed-clean"
  | "installed-stale"
  | "interrupted-write"
  | "locally-modified"
  | "release-revoked"
  | "provenance-malformed"
  | "provenance-unavailable"
  | "source-release-unavailable";

/** Stable status envelope for CLI text/JSON and future update planning. */
export interface TemplateStatus {
  schemaVersion: 1;
  status: TemplateStatusKind;
  profileId: string;
  activeProfileDigest: string;
  templateId: string | null;
  installedVersion: string | null;
  expectedProfileDigest: string | null;
  detail: string;
  sourceType?: TemplateSourceType;
  coordinate?: string;
  stale?: boolean;
  updateAvailable?: string | null;
}

/** Collect status without allowing advisory provenance to affect profile load. */
export async function collectTemplateStatus(root: string, paths: TapPaths = resolveTapPaths()): Promise<TemplateStatus> {
  const loaded = await loadProfile(root);
  const lockRead = await readTemplateLock(root);
  const journal = await journalHealth(root);
  if (journal.status !== "ok") return journalStatus(loaded.profile.profileId, loaded.digest, lockRead, journal.status);
  const base = baseStatus(loaded.profile.profileId, loaded.digest, lockRead);
  if (base) return base;
  const lock = (lockRead as Extract<TemplateLockRead, { kind: "ok" }>).lock;
  if (lock.sourceType === "remote") return remoteStatus(loaded.profile.profileId, loaded.digest, lock, paths);
  const release = resolveTrustedRelease(lock);
  if (!release) return unavailableRelease(loaded.profile.profileId, loaded.digest, lock);
  return compareRelease(loaded.profile.profileId, loaded.digest, lock, release);
}

function journalStatus(
  profileId: string,
  digest: string,
  read: TemplateLockRead,
  health: "pending" | "unavailable",
): TemplateStatus {
  const kind = health === "pending" ? "interrupted-write" : "provenance-unavailable";
  const detail = health === "pending"
    ? "an interrupted project write is pending recovery; run 'llmwiki recover' before trusting template state"
    : "the project journal is unavailable or unsafe; template state cannot be trusted";
  return {
    ...status(kind, profileId, digest, lockId(read), lockVersion(read), null, detail),
    ...journalLockFields(read),
  };
}

function lockId(read: TemplateLockRead): string | null {
  return read.kind === "ok" ? read.lock.templateId : null;
}

function lockVersion(read: TemplateLockRead): string | null {
  return read.kind === "ok" ? read.lock.version : null;
}

function journalLockFields(read: TemplateLockRead): Pick<TemplateStatus, "sourceType" | "coordinate"> {
  if (read.kind !== "ok") return {};
  const coordinate = read.lock.schemaVersion === 2 ? read.lock.remote?.coordinate : undefined;
  return { sourceType: read.lock.sourceType, ...(coordinate ? { coordinate } : {}) };
}

async function remoteStatus(
  profileId: string,
  activeDigest: string,
  lock: TemplateLock,
  paths: TapPaths,
): Promise<TemplateStatus> {
  if (lock.schemaVersion !== 2 || !lock.remote) return unavailableRelease(profileId, activeDigest, lock);
  try {
    return await verifiedRemoteStatus(profileId, activeDigest, lock, paths);
  } catch (error) {
    return remoteResult("source-release-unavailable", profileId, activeDigest, lock, null, errorMessage(error));
  }
}

async function verifiedRemoteStatus(
  profileId: string,
  activeDigest: string,
  lock: TemplateLockV2,
  paths: TapPaths,
): Promise<TemplateStatus> {
  const parsed = remoteCoordinateFromLock(lock);
  const source = (await readTapState(paths)).taps[parsed.tap];
  if (!source) return unavailableRelease(profileId, activeDigest, lock);
  if (isRevoked(lock, source)) {
    return remoteResult("release-revoked", profileId, activeDigest, lock, null, "installed remote release is revoked");
  }
  const resolved = await resolveRemotePackage(paths, lock.remote!.coordinate, { offline: true });
  assertResolvedMatchesLock(lock, resolved.payloadDigest, resolved.publisherKeyId);
  const latest = await latestActiveCoordinate(paths, source, parsed.publisher, parsed.templateId, parsed.version);
  return comparedRemoteStatus(profileId, activeDigest, lock, resolved.package.profile, resolved.indexExpired, latest);
}

function comparedRemoteStatus(
  profileId: string,
  activeDigest: string,
  lock: TemplateLockV2,
  releaseProfile: ProfileTemplatePackage["profile"],
  stale: boolean,
  latest: string | null,
): TemplateStatus {
  const expected = profileDigest(releaseProfile);
  const clean = activeDigest === expected;
  const kind = clean ? (stale ? "installed-stale" : "installed-clean") : "locally-modified";
  const detail = clean
    ? (stale ? "active profile matches a verified release from stale accepted evidence" : "active profile matches the verified remote release")
    : "active profile differs from the verified installed release";
  return remoteResult(kind, profileId, activeDigest, lock, expected, detail, stale, latest);
}

function isRevoked(lock: TemplateLockV2, source: TapSourceState): boolean {
  return source.publisherPins.revokedPackages.includes(lock.remote!.packageDigest)
    || source.publisherPins.revokedPublisherKeys.includes(lock.remote!.publisherKeyId);
}

function assertResolvedMatchesLock(lock: TemplateLockV2, digest: string, publisherKeyId: string): void {
  if (lock.remote!.packageDigest !== digest || lock.remote!.publisherKeyId !== publisherKeyId) {
    throw new Error("verified release differs from advisory provenance locator");
  }
}

async function latestActiveCoordinate(
  paths: TapPaths,
  source: TapSourceState,
  publisher: string,
  templateId: string,
  installedVersion: string,
): Promise<string | null> {
  const index = await loadAcceptedIndex(paths, source);
  const active = index.packages.filter((entry) => {
    const coordinate = parseTemplateCoordinate(entry.coordinate);
    return entry.publisher === publisher
      && coordinate.templateId === templateId
      && !source.publisherPins.revokedPackages.includes(entry.payloadDigest)
      && !source.publisherPins.revokedPublisherKeys.includes(index.publishers[publisher]?.keyId ?? "");
  });
  const newer = active.filter((entry) => compareTemplateVersions(parseTemplateCoordinate(entry.coordinate).version, installedVersion) > 0);
  newer.sort((left, right) => compareTemplateVersions(
    parseTemplateCoordinate(right.coordinate).version,
    parseTemplateCoordinate(left.coordinate).version,
  ));
  return newer[0]?.coordinate ?? null;
}

function remoteResult(
  kind: TemplateStatusKind,
  profileId: string,
  activeDigest: string,
  lock: TemplateLockV2,
  expectedDigest: string | null,
  detail: string,
  stale = false,
  updateAvailable: string | null = null,
): TemplateStatus {
  return {
    ...status(kind, profileId, activeDigest, lock.templateId, lock.version, expectedDigest, detail),
    sourceType: "remote",
    coordinate: lock.remote!.coordinate,
    stale,
    updateAvailable,
  };
}

function baseStatus(profileId: string, digest: string, read: TemplateLockRead): TemplateStatus | null {
  if (read.kind === "absent") return status("untracked", profileId, digest, null, null, null, "no advisory template lock is present");
  if (read.kind === "malformed") return status("provenance-malformed", profileId, digest, null, null, null, read.detail);
  if (read.kind === "unavailable") return status("provenance-unavailable", profileId, digest, null, null, null, read.detail);
  return null;
}

function resolveTrustedRelease(lock: TemplateLock): ProfileTemplatePackage | null {
  if (lock.sourceType !== "builtin") return null;
  const pkg = getBuiltinTemplate(lock.templateId);
  if (!pkg || pkg.version !== lock.version || pkg.publisher !== lock.publisher) return null;
  return pkg;
}

function compareRelease(profileId: string, activeDigest: string, lock: TemplateLock, pkg: ProfileTemplatePackage): TemplateStatus {
  const expected = profileDigest(pkg.profile);
  const isClean = activeDigest === expected;
  return status(
    isClean ? "installed-clean" : "locally-modified",
    profileId,
    activeDigest,
    lock.templateId,
    lock.version,
    expected,
    isClean ? "active profile matches the verified builtin release" : "active profile differs from the verified installed release",
  );
}

function unavailableRelease(profileId: string, digest: string, lock: TemplateLock): TemplateStatus {
  return status(
    "source-release-unavailable", profileId, digest, lock.templateId, lock.version, null,
    `cannot independently resolve ${lock.sourceType} release ${lock.templateId}@${lock.version}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function status(
  kind: TemplateStatusKind,
  profileId: string,
  activeProfileDigest: string,
  templateId: string | null,
  installedVersion: string | null,
  expectedProfileDigest: string | null,
  detail: string,
): TemplateStatus {
  return { schemaVersion: 1, status: kind, profileId, activeProfileDigest, templateId, installedVersion, expectedProfileDigest, detail };
}
