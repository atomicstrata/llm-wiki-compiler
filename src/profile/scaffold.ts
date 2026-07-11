/**
 * @file src/profile/scaffold.ts
 * @description Builds and installs the minimal profile used by beginner onboarding.
 */

import { lstat, mkdir, realpath, rmdir } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../utils/atomic-write.js";
import { readCappedNoFollow } from "../utils/confined-read.js";
import { CONCEPTS_DIR, MAX_PROFILE_BYTES, PROFILE_FILE, QUERIES_DIR } from "../utils/constants.js";
import { acquireLockBlocking, releaseLock } from "../utils/lock.js";
import { confineUnderRoot, isInsideDir } from "../utils/path-confine.js";
import { resolveExistingConfinedPrivateDir } from "../utils/private-dir.js";
import { isSlugSafe } from "./identity.js";
import { loadProfile } from "./load.js";
import { isTypedCorpusEmpty } from "./templates/corpus.js";
import type { ProfilePack } from "./types.js";
import { validateProfile } from "./validate.js";

/** Whether a failed scaffold operation wrote its active profile. */
export type ProfileInstallOutcome = "installed" | "not-installed" | "unknown";

/** Error raised when a starter profile cannot be built or installed safely. */
export class ProfileScaffoldError extends Error {
  constructor(message: string, readonly outcome: ProfileInstallOutcome = "not-installed") {
    super(message);
    this.name = "ProfileScaffoldError";
  }
}

const RESERVED_PROFILE_NAMES = new Set(["default"]);
const RESERVED_PAGE_TYPES = new Set([path.basename(CONCEPTS_DIR), path.basename(QUERIES_DIR)]);

/** Convert a validated hyphenated identifier into an ASCII display name. */
function displayNameFor(profileId: string): string {
  return profileId
    .split("-")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

/** Require the existing lowercase identifier grammar with beginner-facing wording. */
function assertBeginnerIdentifier(value: string, label: string, reserved: ReadonlySet<string>): void {
  if (!isSlugSafe(value)) {
    throw new ProfileScaffoldError(`${label} must use lowercase letters, numbers, and hyphens`);
  }
  if (reserved.has(value)) {
    throw new ProfileScaffoldError(`${label} '${value}' is already used by llmwiki; choose a different name`);
  }
}

/** Build and validate the deterministic one-entity starter profile. */
export function buildStarterProfile(profileId: string, entityType: string): ProfilePack {
  assertBeginnerIdentifier(profileId, "Profile name", RESERVED_PROFILE_NAMES);
  assertBeginnerIdentifier(entityType, "Page type", RESERVED_PAGE_TYPES);
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
  return canonicalProfileJson(buildStarterProfile(profileId, entityType));
}

/** Serialize one already-validated starter profile deterministically. */
function canonicalProfileJson(profile: ProfilePack): string {
  return `${JSON.stringify(profile, null, 2)}\n`;
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
  confirmProfileCommit?: (root: string, body: string) => Promise<ProfileCommitStatus>;
}

/** Commit verification outcome after a profile write throws. */
export type ProfileCommitStatus = "committed" | "absent" | "unknown";

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

/** Distinguish a committed profile, a confirmed absence, and an unreadable state. */
async function confirmProfileCommit(root: string, body: string): Promise<ProfileCommitStatus> {
  const privateDir = await resolveExistingConfinedPrivateDir(root).catch(() => undefined);
  if (privateDir === undefined) return "unknown";
  if (privateDir === null) return "absent";
  const read = await readCappedNoFollow(path.join(privateDir, path.basename(PROFILE_FILE)), MAX_PROFILE_BYTES);
  if (read.kind === "absent") return "absent";
  if (read.kind !== "ok" || read.body !== body) return "unknown";
  return "committed";
}

/** Render a refusal that distinguishes existing content from unreadable state. */
function corpusRefusal(reasons: string[]): ProfileScaffoldError {
  const unavailable = reasons.some((reason) => /unreadable|unsafe|problems/.test(reason));
  const summary = unavailable ? "Project state could not be verified" : "Typed corpus is not empty";
  return new ProfileScaffoldError(`${summary}.\n- ${reasons.join("\n- ")}`);
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
    if (loaded.loadedFrom !== null) throw new ProfileScaffoldError("A profile already exists.");
    const probe = await isTypedCorpusEmpty(root, loaded, profile);
    if (!probe.empty) throw corpusRefusal(probe.reasons);
    const createdDirectory = await prepareEntityDirectory(root, directory);
    const profileBody = canonicalProfileJson(profile);
    try {
      await (dependencies.writeProfile ?? writeProfile)(root, profileBody);
    } catch (error) {
      const commit = await (dependencies.confirmProfileCommit ?? confirmProfileCommit)(root, profileBody);
      if (commit === "committed") {
        throw new ProfileScaffoldError(
          `Profile was installed, but durability confirmation failed: ${errorMessage(error)}`,
          "installed",
        );
      }
      if (commit === "unknown") {
        throw new ProfileScaffoldError(
          `Installation state could not be confirmed after a write failure; no cleanup was attempted: ${errorMessage(error)}`,
          "unknown",
        );
      }
      if (createdDirectory) await compensateDirectory(path.join(root, directory), error);
      throw new ProfileScaffoldError(errorMessage(error));
    }
    return { profileId, entityType, directory };
  } finally {
    await releaseLock(root);
  }
}
