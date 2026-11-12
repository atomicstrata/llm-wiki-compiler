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
 * The open, the size check, the read and the close are one local-disk storage
 * read (`readLeafTextNoFollowCapped`); what each outcome MEANS is decided here.
 *
 * ONE BODY: {@link loadProfile} runs {@link loadProfileFrom} over local-disk
 * {@link EffectiveProfileSources}. Mode precedence, "missing is the default",
 * "present but broken is an error", every error class and message and the
 * logical `loadedFrom` are decided in this file; the sources only look. Every
 * call reads the file again; only the verdict on text already validated is
 * reused (`validated-text.ts`: once per process per exact text, failures never
 * kept, a private copy per caller). Nothing else is remembered between calls —
 * EXCEPT inside one lock-held section (`utils/lock-held-reads.ts`), where the
 * project lock keeps every writer out, so the first load serves the rest of
 * that section and each caller still receives its own copy of the profile.
 *
 * ACYCLIC RULE: this module imports `products/binding`, never the reverse. The
 * binding resolver loads the knowledge-profile member and validates it directly
 * via `validatedProfileText`; it must never call back into `loadProfile`.
 */

import path from "node:path";
import { readLeafTextNoFollowCapped, type CappedTextNoFollowRead } from "../storage/disk-handle-leaves.js";
import { PROFILE_FILE, MAX_PROFILE_BYTES } from "../utils/constants.js";
import { PrivateDirConfinementError } from "../utils/private-dir.js";
import { DEFAULT_PROFILE } from "./default.js";
import { validatedProfileText } from "./validated-text.js";
import { profileDigest } from "./digest.js";
import type { LoadedProfile } from "./types.js";
import {
  diskActiveProductSources, resolveActiveProductFrom, type ActiveProductSources,
} from "../products/binding/resolve.js";
import { ActiveProductUnavailableError, ProductAuthorityConflictError } from "../products/binding/problems.js";
import type { ActiveProductResolution } from "../products/binding/resolve.js";
import { inLockHeldSection, readOncePerLockHold } from "../utils/lock-held-reads.js";

/** Error raised when a present profile file cannot be loaded or validated. */
export class ProfileLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileLoadError";
  }
}

/**
 * Everything {@link loadProfileFrom} reads. OWNED BY THE PROFILE LOADER: a narrow
 * seam with one disk implementation; not `ProjectStore`, not a hosted or
 * access-control contract, and it selects no backend.
 */
export interface EffectiveProfileSources {
  /**
   * The active-product sources, resolved FIRST. Their `root` is also the one
   * origin of the legacy `loadedFrom` path, and their `binding.resolvePrivateDir`
   * is the private-directory look the legacy loader uses.
   */
  activeProduct: ActiveProductSources;
  /**
   * One leaf of a resolved private directory, opened WITHOUT following a link
   * and read as text only when within `maxBytes`. A failed open is a VALUE
   * carrying the raw error; a leaf over the cap is a value and is never read; a
   * failed read REJECTS raw.
   */
  readPrivateLeafText(dir: string, name: string, maxBytes: number): Promise<CappedTextNoFollowRead>;
}

/** LOCAL DISK. The sources for the project at `root`. Building them does no I/O. In no package index. */
export function diskEffectiveProfileSources(root: string): EffectiveProfileSources {
  return {
    activeProduct: diskActiveProductSources(root),
    readPrivateLeafText: (dir, name, maxBytes) => readLeafTextNoFollowCapped(path.join(dir, name), maxBytes),
  };
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
 * Decide what a FAILED no-follow open of `profile.json` means. The storage read
 * opens the leaf with `O_NOFOLLOW`, so a symlinked leaf fails the `open` call
 * with `ELOOP` — never reading out-of-tree bytes — and hands the raw open error
 * back here. Returns (absent) only for ENOENT → caller yields default. Throws
 * `ProfileLoadError` on symlink (`ELOOP`) or any other unexpected open error.
 */
function assertProfileOpenFailureIsAbsence(err: unknown): void {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return;
  if (code === "ELOOP") throw new ProfileLoadError(`${PROFILE_FILE} is a symlink — refusing to follow`);
  throw new ProfileLoadError(`Failed to read ${PROFILE_FILE}: ${describe(err)}`);
}

/**
 * Resolve the confined `.llmwiki` dir, mapping a symlinked/escaping dir to a
 * {@link ProfileLoadError} — the pre-existing read-path confinement contract. A
 * clean project (no `.llmwiki`) resolves to `null` WITHOUT creating the directory.
 */
async function resolveConfinedProfileDir(sources: EffectiveProfileSources): Promise<string | null> {
  try {
    return await sources.activeProduct.binding.resolvePrivateDir();
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
async function loadLegacyProfile(sources: EffectiveProfileSources): Promise<LoadedProfile> {
  const dir = await resolveConfinedProfileDir(sources);
  // Absent .llmwiki dir means no profile file — yield the built-in default without
  // creating the directory (read-only contract: a clean project stays clean).
  if (dir === null) return defaultLoadedProfile();
  // Use the realpath-resolved confined path for the open (confinement) but keep the
  // original logical path for `loadedFrom` so callers see a stable, user-facing path.
  const logicalFilePath = path.join(sources.activeProduct.root, PROFILE_FILE);
  const read = await sources.readPrivateLeafText(dir, path.basename(PROFILE_FILE), MAX_PROFILE_BYTES);
  if (read.kind === "not-opened") {
    assertProfileOpenFailureIsAbsence(read.error);
    return defaultLoadedProfile();
  }
  if (read.kind === "oversize") {
    throw new ProfileLoadError(`${PROFILE_FILE} is ${read.size} bytes — exceeds the ${MAX_PROFILE_BYTES}-byte cap`);
  }
  const { profile, digest } = validatedProfileText(read.text,
    (parseError) => new ProfileLoadError(`Invalid JSON in ${logicalFilePath}: ${describe(parseError)}`));
  return { profile, loadedFrom: logicalFilePath, digest };
}

/**
 * A symlinked/escaping `.llmwiki` dir is a legacy confinement fault of the WHOLE
 * private dir, not a present-binding fault, so it must surface as the pre-existing
 * {@link ProfileLoadError} read-path contract rather than an unavailable-binding
 * error. When the dir resolves cleanly (or is absent) this returns and the caller
 * raises the binding-specific {@link ActiveProductUnavailableError}.
 */
async function assertPrivateDirNotConfinementFault(sources: EffectiveProfileSources): Promise<void> {
  await resolveConfinedProfileDir(sources);
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
  // `async` so that a throw while the disk sources are built REJECTS, as this function always did.
  const sources = diskEffectiveProfileSources(root);
  if (!inLockHeldSection()) return loadProfileFrom(sources);
  const shared = await readOncePerLockHold("effective-profile", root,
    async () => loadProfileFor(sources, await activeProductForLockHold(root)));
  return privateCopy(shared);
}

/**
 * The project's active-product resolution, read once per lock-held section and
 * shared with the profile load of that section; outside one, read every call.
 * Callers only read it.
 */
export function activeProductForLockHold(root: string): Promise<ActiveProductResolution> {
  return readOncePerLockHold("active-product", root,
    () => resolveActiveProductFrom(diskActiveProductSources(root)));
}

/**
 * A shared load as a caller may own it: a fresh profile object, as a fresh read
 * would give. The built-in default was always one shared object.
 */
function privateCopy(loaded: LoadedProfile): LoadedProfile {
  return loaded.loadedFrom === null ? { ...loaded } : { ...loaded, profile: structuredClone(loaded.profile) };
}

/**
 * {@link loadProfile} over {@link EffectiveProfileSources}: THE ONE BODY. The
 * product is resolved first; the four modes are mapped exactly as documented
 * above; an unavailable binding re-resolves the private directory BEFORE it
 * throws, so a confinement fault there outranks it. It NEVER falls back.
 */
export async function loadProfileFrom(sources: EffectiveProfileSources): Promise<LoadedProfile> {
  return loadProfileFor(sources, await resolveActiveProductFrom(sources.activeProduct));
}

/** {@link loadProfileFrom} once the product is resolved: the four modes. */
async function loadProfileFor(sources: EffectiveProfileSources, resolution: ActiveProductResolution): Promise<LoadedProfile> {
  if (resolution.mode === "legacy") return loadLegacyProfile(sources);
  if (resolution.mode === "product") return resolution.loaded;
  if (resolution.mode === "conflict") throw new ProductAuthorityConflictError();
  await assertPrivateDirNotConfinementFault(sources);
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

/** Extract a human-readable message from an unknown thrown value. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
