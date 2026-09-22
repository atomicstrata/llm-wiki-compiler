/**
 * Fail-closed, binding-aware effective-profile loader.
 *
 * `loadProfile` is the UNIVERSAL effective-authority resolver (design section 8.2):
 * every reader that loads a project's profile authorizes against the EXACT active
 * product and its knowledge profile when a binding is present, and against the
 * legacy `.llmwiki/profile.json`-or-built-in-default otherwise. It first classifies
 * the runtime mode via the active-product binding, then:
 *   - ABSENT binding → the LEGACY path ({@link loadLegacyProfile}), byte-identical
 *     to the pre-binding loader (same profile, `loadedFrom`, and digest);
 *   - PRESENT, healthy binding → the product's knowledge profile;
 *   - binding beside a legacy `profile.json` → {@link ProductAuthorityConflictError};
 *   - present-but-unhealthy binding → {@link ActiveProductUnavailableError}, NEVER
 *     a silent fall back to legacy/default.
 *
 * The LEGACY path is itself fail-closed, mirroring the review-config pattern: a
 * MISSING file falls back to the built-in default profile, but a file that is
 * PRESENT yet broken (unparseable JSON or schema-invalid) is a hard error. A typo
 * in a present profile must never silently degrade the project to the default
 * profile, because that would change every entity's identity and retrieval
 * behaviour without warning.
 *
 * The returned `LoadedProfile` carries the resolved pack, its absolute source
 * path (or `null` for the built-in default), and its canonical digest.
 *
 * Confinement: the legacy read is routed through the confined `.llmwiki` dir
 * primitive (`resolveExistingConfinedPrivateDir`) and the leaf is opened with
 * `O_NOFOLLOW` so a symlinked `.llmwiki` dir OR a symlinked `profile.json` leaf
 * FAILS CLOSED (never reads out-of-tree bytes). An `fstat`-based size cap guards
 * against reading a multi-GB or `/dev/zero`-backed target before `JSON.parse`.
 *
 * ACYCLIC RULE: this module imports `products/binding`, never the reverse. The
 * binding resolver loads the knowledge-profile member and validates it directly
 * via `validateProfile`/`profileDigest`; it must never call back into `loadProfile`.
 */

import { constants as fsConstants } from "node:fs";
import { openFileNoFollow } from "../utils/no-follow-open.js";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { PROFILE_FILE, MAX_PROFILE_BYTES } from "../utils/constants.js";
import { resolveExistingConfinedPrivateDir, PrivateDirConfinementError } from "../utils/private-dir.js";
import { DEFAULT_PROFILE } from "./default.js";
import { validateProfile } from "./validate.js";
import { profileDigest } from "./digest.js";
import type { LoadedProfile } from "./types.js";
import { resolveActiveProduct } from "../products/binding/resolve.js";
import { ActiveProductUnavailableError, ProductAuthorityConflictError } from "../products/binding/problems.js";

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
    return await openFileNoFollow(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw new ProfileLoadError(`${PROFILE_FILE} is a symlink — refusing to follow`);
    throw new ProfileLoadError(`Failed to read ${PROFILE_FILE}: ${describe(err)}`);
  }
}

/**
 * Resolve the confined `.llmwiki` dir, mapping a symlinked/escaping dir to a
 * {@link ProfileLoadError} — the pre-existing read-path confinement contract. A
 * clean project (no `.llmwiki`) resolves to `null` WITHOUT creating the directory.
 */
async function resolveConfinedProfileDir(root: string): Promise<string | null> {
  try {
    return await resolveExistingConfinedPrivateDir(root);
  } catch (err) {
    if (err instanceof PrivateDirConfinementError) {
      throw new ProfileLoadError(`${PROFILE_FILE} directory is a symlink — refusing to follow`);
    }
    throw err;
  }
}

/**
 * The LEGACY fail-closed loader: resolve `<root>/.llmwiki/profile.json`, yielding
 * the built-in default when absent and failing closed on a present-but-broken or
 * confined file. This is the exact behaviour {@link loadProfile} runs when NO
 * active-product binding is present, so the absent-binding result (profile,
 * `loadedFrom`, and digest) stays byte-identical to the pre-binding loader.
 *
 * @param root - Absolute project root directory.
 * @returns The resolved, validated legacy profile with its source path and digest.
 * @throws {ProfileLoadError} When a present file is unparseable, invalid, or confined.
 */
async function loadLegacyProfile(root: string): Promise<LoadedProfile> {
  const dir = await resolveConfinedProfileDir(root);
  // Absent .llmwiki dir means no profile file — yield the built-in default without
  // creating the directory (read-only contract: a clean project stays clean).
  if (dir === null) return defaultLoadedProfile();
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

/**
 * A symlinked/escaping `.llmwiki` dir is a legacy confinement fault of the WHOLE
 * private dir, not a present-binding fault, so it must surface as the pre-existing
 * {@link ProfileLoadError} read-path contract rather than an unavailable-binding
 * error. When the dir resolves cleanly (or is absent) this returns and the caller
 * raises the binding-specific {@link ActiveProductUnavailableError}.
 */
async function assertPrivateDirNotConfinementFault(root: string): Promise<void> {
  await resolveConfinedProfileDir(root);
}

/**
 * Load the EFFECTIVE profile for a project root — the UNIVERSAL effective-authority
 * resolver every reader uses (design section 8.2). Routes through the active-product
 * binding: an ABSENT binding is the LEGACY path ({@link loadLegacyProfile}, byte-
 * identical to the pre-binding loader); a PRESENT, healthy binding yields the
 * product's knowledge profile; a binding beside a legacy `profile.json` fails closed
 * with {@link ProductAuthorityConflictError} (neither wins); a present-but-unhealthy
 * binding throws {@link ActiveProductUnavailableError} and NEVER falls back to legacy.
 *
 * A symlinked/escaping `.llmwiki` dir surfaces as a {@link ProfileLoadError} (the
 * legacy confinement contract), not as an unavailable-binding error, because the
 * fault is the private dir itself rather than a present binding.
 *
 * @param root - Absolute project root directory.
 * @returns The resolved effective profile for the project's runtime mode.
 * @throws {ProductAuthorityConflictError} When a binding and `profile.json` coexist.
 * @throws {ActiveProductUnavailableError} When a present binding is unhealthy.
 * @throws {ProfileLoadError} When the legacy `profile.json` is present but broken/confined.
 */
export async function loadProfile(root: string): Promise<LoadedProfile> {
  const resolution = await resolveActiveProduct(root);
  if (resolution.mode === "legacy") return loadLegacyProfile(root);
  if (resolution.mode === "product") return resolution.loaded;
  if (resolution.mode === "conflict") throw new ProductAuthorityConflictError();
  await assertPrivateDirNotConfinementFault(root);
  throw new ActiveProductUnavailableError(resolution.detail);
}

/**
 * The canonical DIGEST of the project's ACTIVE profile — the exact content-address
 * {@link loadProfile} binds. A generic, read-only profile OBSERVATION: a host or product
 * can confirm which profile configuration is active (e.g. to bind a live projection to the
 * profile it verified against) WITHOUT the loader itself being public. Carries no product
 * vocabulary — it reads whatever profile is installed.
 */
export async function activeProfileDigest(root: string): Promise<string> {
  return (await loadProfile(root)).digest;
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
