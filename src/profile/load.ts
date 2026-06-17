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
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { PROFILE_FILE } from "../utils/constants.js";
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

/** True when a filesystem error is a "no such file or directory" error. */
function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
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
 * Load the effective profile for a project root.
 *
 * Resolves `<root>/.llmwiki/profile.json`. A missing file yields the built-in
 * default profile with `loadedFrom: null`. A present file is parsed and
 * validated; any failure throws `ProfileLoadError` (fail-closed — the default
 * is never substituted for a broken present file).
 *
 * @param root - Absolute project root directory.
 * @returns The resolved, validated profile with its source path and digest.
 * @throws {ProfileLoadError} When a present file is unparseable or invalid.
 */
export async function loadProfile(root: string): Promise<LoadedProfile> {
  const filePath = path.join(root, PROFILE_FILE);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (isNotFound(err)) return defaultLoadedProfile();
    throw new ProfileLoadError(`Failed to read ${PROFILE_FILE}: ${describe(err)}`);
  }
  const parsed = parseOrThrow(raw, filePath);
  const { profile } = validateProfile(parsed);
  return { profile, loadedFrom: filePath, digest: profileDigest(profile) };
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
