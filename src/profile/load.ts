/**
 * Fail-closed profile loader.
 *
 * Resolves a project's effective profile pack from `.llmwiki/profile.json`.
 * The loader is fail-closed by design, mirroring the review-config pattern: a
 * MISSING file falls back to the built-in default profile, but a file that is
 * PRESENT yet broken (unparseable JSON or schema-invalid) is a hard error. A
 * typo in a present profile must never silently degrade the project to the
 * default profile, because that would change every entity's identity and
 * retrieval behaviour without warning.
 *
 * The returned `LoadedProfile` carries the resolved pack, its absolute source
 * path (or `null` for the built-in default), and its canonical digest.
 *
 * Confinement: the read is routed through the confined `.llmwiki` dir primitive
 * (`resolveConfinedPrivateDir`) and the leaf is opened with `O_NOFOLLOW` so a
 * symlinked `.llmwiki` dir OR a symlinked `profile.json` leaf FAILS CLOSED
 * (never reads out-of-tree bytes). An `fstat`-based size cap guards against
 * reading a multi-GB or `/dev/zero`-backed target before `JSON.parse`.
 */

import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { PROFILE_FILE, MAX_PROFILE_BYTES } from "../utils/constants.js";
import { resolveConfinedPrivateDir, PrivateDirConfinementError } from "../utils/private-dir.js";
import { DEFAULT_PROFILE } from "./default.js";
import { validateProfile } from "./validate.js";
import { profileDigest } from "./digest.js";
import type { LoadedProfile } from "./types.js";

/** Error raised when a present profile file cannot be loaded or validated. */
export class ProfileLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileLoadError";
  }
}

/** The LoadedProfile for the built-in default profile (no source file). */
function defaultLoadedProfile(): LoadedProfile {
  return {
    profile: DEFAULT_PROFILE,
    loadedFrom: null,
    digest: profileDigest(DEFAULT_PROFILE),
  };
}

/**
 * Open `profile.json` with `O_NOFOLLOW` so a symlinked leaf fails the `open`
 * call with `ELOOP` — never reading out-of-tree bytes. Returns `null` when
 * absent (ENOENT → caller yields default). Throws `ProfileLoadError` on
 * symlink (`ELOOP`) or any other unexpected open error.
 */
async function openProfileNoFollow(filePath: string): Promise<FileHandle | null> {
  try {
    return await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw new ProfileLoadError(`${PROFILE_FILE} is a symlink — refusing to follow`);
    throw new ProfileLoadError(`Failed to read ${PROFILE_FILE}: ${describe(err)}`);
  }
}

/**
 * Load the effective profile for a project root.
 *
 * Resolves `<root>/.llmwiki/profile.json`. A missing file yields the built-in
 * default profile with `loadedFrom: null`. A present file is parsed and
 * validated; any failure throws `ProfileLoadError` (fail-closed — the default
 * is never substituted for a broken present file). A symlinked `.llmwiki` dir
 * or a symlinked `profile.json` leaf also fails closed.
 *
 * @param root - Absolute project root directory.
 * @returns The resolved, validated profile with its source path and digest.
 * @throws {ProfileLoadError} When a present file is unparseable, invalid, or confined.
 */
export async function loadProfile(root: string): Promise<LoadedProfile> {
  let dir: string;
  try {
    dir = await resolveConfinedPrivateDir(root);
  } catch (err) {
    if (err instanceof PrivateDirConfinementError) {
      throw new ProfileLoadError(`${PROFILE_FILE} directory is a symlink — refusing to follow`);
    }
    throw err;
  }
  // Use the realpath-resolved confined path for the open (confinement) but keep the
  // original logical path for `loadedFrom` so callers see a stable, user-facing path.
  const confinedFilePath = path.join(dir, path.basename(PROFILE_FILE));
  const logicalFilePath = path.join(root, PROFILE_FILE);
  const handle = await openProfileNoFollow(confinedFilePath);
  if (handle === null) return defaultLoadedProfile();
  let raw: string;
  try {
    const size = (await handle.stat()).size;
    if (size > MAX_PROFILE_BYTES) {
      throw new ProfileLoadError(`${PROFILE_FILE} is ${size} bytes — exceeds the ${MAX_PROFILE_BYTES}-byte cap`);
    }
    raw = await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
  const parsed = parseOrThrow(raw, logicalFilePath);
  const { profile } = validateProfile(parsed);
  return { profile, loadedFrom: logicalFilePath, digest: profileDigest(profile) };
}

/** Parse profile JSON, failing closed (never falling back) on broken content. */
function parseOrThrow(raw: string, filePath: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ProfileLoadError(`Invalid JSON in ${filePath}: ${describe(err)}`);
  }
}

/** Extract a human-readable message from an unknown thrown value. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
