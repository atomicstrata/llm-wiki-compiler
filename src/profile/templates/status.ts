/**
 * @file src/profile/templates/status.ts
 * @description Read-only template provenance and profile-drift status.
 * Advisory lock fields locate a release; independently resolved release bytes
 * determine whether the active profile matches what was installed.
 */
import { profileDigest } from "../digest.js";
import { loadProfile } from "../load.js";
import { getBuiltinTemplate } from "./registry.js";
import { readTemplateLock, type TemplateLockRead } from "./lock.js";
import type { ProfileTemplatePackage, TemplateLock } from "./types.js";

export type TemplateStatusKind =
  | "untracked"
  | "installed-clean"
  | "locally-modified"
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
}

/** Collect status without allowing advisory provenance to affect profile load. */
export async function collectTemplateStatus(root: string): Promise<TemplateStatus> {
  const loaded = await loadProfile(root);
  const lockRead = await readTemplateLock(root);
  const base = baseStatus(loaded.profile.profileId, loaded.digest, lockRead);
  if (base) return base;
  const lock = (lockRead as Extract<TemplateLockRead, { kind: "ok" }>).lock;
  const release = resolveTrustedRelease(lock);
  if (!release) return unavailableRelease(loaded.profile.profileId, loaded.digest, lock);
  return compareRelease(loaded.profile.profileId, loaded.digest, lock, release);
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
