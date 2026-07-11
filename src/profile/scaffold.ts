/**
 * @file src/profile/scaffold.ts
 * @description Builds and installs the minimal profile used by beginner onboarding.
 */

import { lstat, mkdir, realpath, rmdir } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../utils/atomic-write.js";
import { readCappedNoFollow } from "../utils/confined-read.js";
import { MAX_PROFILE_BYTES, PROFILE_FILE } from "../utils/constants.js";
import { acquireLockBlocking, releaseLock } from "../utils/lock.js";
import { confineUnderRoot, isInsideDir } from "../utils/path-confine.js";
import { isSlugSafe } from "./identity.js";
import { loadProfile } from "./load.js";
import { isTypedCorpusEmpty } from "./templates/corpus.js";
import type { ProfilePack } from "./types.js";
import { validateProfile } from "./validate.js";

/** Error raised when a starter profile cannot be built or installed safely. */
class ProfileScaffoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileScaffoldError";
  }
}

/** Convert a validated hyphenated identifier into an ASCII display name. */
function displayNameFor(profileId: string): string {
  return profileId
    .split("-")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

/** Require the existing lowercase identifier grammar with beginner-facing wording. */
function assertBeginnerIdentifier(value: string, label: string): void {
  if (!isSlugSafe(value)) {
    throw new ProfileScaffoldError(`${label} must use lowercase letters, numbers, and hyphens`);
  }
}

/** Build and validate the deterministic one-entity starter profile. */
export function buildStarterProfile(profileId: string, entityType: string): ProfilePack {
  assertBeginnerIdentifier(profileId, "Profile name");
  assertBeginnerIdentifier(entityType, "Page type");
  const candidate: ProfilePack = {
    schemaVersion: 1,
    profileId,
    displayName: displayNameFor(profileId),
    entities: {
      [entityType]: {
        directory: `wiki/${entityType}`,
        titleField: "title",
        requiredFields: ["title"],
        fields: { title: { type: "string" } },
      },
    },
  };
  return validateProfile(candidate).profile;
}

/** Return the canonical bytes written by the starter-profile installer. */
export function canonicalStarterProfileJson(profileId: string, entityType: string): string {
  return `${JSON.stringify(buildStarterProfile(profileId, entityType), null, 2)}\n`;
}

/** Successful scaffold installation details surfaced by the CLI. */
export interface ProfileScaffoldResult {
  profileId: string;
  entityType: string;
  directory: string;
}

/** Narrow test seam for deterministic post-directory write failure coverage. */
export interface ProfileScaffoldDependencies {
  writeProfile?: (root: string, body: string) => Promise<void>;
}

/** Atomically write the active profile as the scaffold's commit point. */
async function writeProfile(root: string, body: string): Promise<void> {
  await atomicWrite(path.join(root, PROFILE_FILE), body, { confineRoot: root, durable: true });
}

/** Create or verify the declared entity directory and report command ownership. */
async function prepareEntityDirectory(root: string, directory: string): Promise<boolean> {
  const target = await confineUnderRoot(directory, root, { mustExist: false });
  let created: string | undefined;
  try {
    created = await mkdir(target, { recursive: true });
  } catch (error) {
    throw new ProfileScaffoldError(`Entity directory is unsafe or cannot be created: ${directory}: ${errorMessage(error)}`);
  }
  await assertRealDirectory(root, target, directory);
  return created !== undefined;
}

/** Verify the literal target is a real directory confined beneath the project. */
async function assertRealDirectory(root: string, target: string, directory: string): Promise<void> {
  const stat = await lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ProfileScaffoldError(`Entity directory is unsafe: ${directory}`);
  }
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  if (!isInsideDir(realTarget, realRoot)) {
    throw new ProfileScaffoldError(`Entity directory escapes the project: ${directory}`);
  }
}

/** Remove only an empty entity directory created by this failed operation. */
async function compensateDirectory(target: string, originalError: unknown): Promise<never> {
  try {
    await rmdir(target);
  } catch (cleanupError) {
    throw new ProfileScaffoldError(
      `${errorMessage(originalError)}; cleanup failed for ${target}: ${errorMessage(cleanupError)}`,
    );
  }
  throw originalError;
}

/** Render an unknown failure for a stable operator-facing error. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when the intended profile bytes reached the commit path despite a late error. */
async function profileCommitMatches(root: string, body: string): Promise<boolean> {
  const read = await readCappedNoFollow(path.join(root, PROFILE_FILE), MAX_PROFILE_BYTES).catch(() => null);
  return read?.kind === "ok" && read.body === body;
}

/** Install a minimal profile only when no existing typed corpus can be reinterpreted. */
export async function installStarterProfile(
  root: string,
  profileId: string,
  entityType: string,
  dependencies: ProfileScaffoldDependencies = {},
): Promise<ProfileScaffoldResult> {
  const profile = buildStarterProfile(profileId, entityType);
  const directory = profile.entities[entityType].directory;
  await acquireLockBlocking(root);
  try {
    const loaded = await loadProfile(root);
    if (loaded.loadedFrom !== null) throw new ProfileScaffoldError("A profile already exists. No profile was installed.");
    const probe = await isTypedCorpusEmpty(root, loaded, profile);
    if (!probe.empty) {
      throw new ProfileScaffoldError(`Typed corpus is not empty. No profile was installed.\n- ${probe.reasons.join("\n- ")}`);
    }
    const createdDirectory = await prepareEntityDirectory(root, directory);
    const profileBody = canonicalStarterProfileJson(profileId, entityType);
    try {
      await (dependencies.writeProfile ?? writeProfile)(root, profileBody);
    } catch (error) {
      if (await profileCommitMatches(root, profileBody)) {
        throw new ProfileScaffoldError(
          `Profile was installed, but durability confirmation failed: ${errorMessage(error)}`,
        );
      }
      if (createdDirectory) await compensateDirectory(path.join(root, directory), error);
      throw error;
    }
    return { profileId, entityType, directory };
  } finally {
    await releaseLock(root);
  }
}
