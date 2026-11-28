/**
 * @file src/profile/non-default.ts
 * @description The NON-DEFAULT PROFILE loader: the project's effective profile,
 * or `undefined` when it is the built-in default. Kept apart from
 * `./block.ts` (which re-exports it for every existing importer) so a caller
 * that only needs this answer — the knowledge-change history guard — does not
 * import the profile lint machinery and, through it, the relation and event
 * stores (which reach the mutation lock gate and journal recovery, and so
 * would close an import cycle back to the history recovery).
 */

import { DEFAULT_PROFILE } from "./default.js";
import { profileDigest } from "./digest.js";
import { diskEffectiveProfileSources, loadProfileFrom, type EffectiveProfileSources } from "./load.js";
import type { LoadedProfile } from "./types.js";

/**
 * Load the active profile and return it ONLY when it is a non-default profile;
 * return `undefined` for the built-in default so every additive read surface
 * can omit its `profile` key with one shared gate.
 *
 * The built-in is identified by `loadedFrom === null` (the loader sets null
 * ONLY for the no-file/default path) — never by `profileId === "default"`,
 * which a disk profile can no longer claim but which must not be the gate. The
 * digest comparison is defense-in-depth against a future loader change.
 *
 * Effective-profile loading routes through the active-product binding via the
 * universal {@link loadProfile}: with no binding this is byte-identical to the
 * legacy path, and a product-mode binding yields the product's knowledge profile
 * (always non-default, since its `loadedFrom` is a package member path, so it is
 * never mistaken for the built-in default).
 *
 * @param root - Absolute project root directory.
 * @returns The loaded non-default profile, or `undefined` for the built-in default.
 */
export async function loadNonDefaultProfile(
  root: string,
): Promise<LoadedProfile | undefined> {
  // `async` so that a throw while the disk sources are built REJECTS, as this function always did.
  return loadNonDefaultProfileFrom(diskEffectiveProfileSources(root));
}

/** {@link loadNonDefaultProfile} over the profile sources: THE ONE BODY. One load, then the one gate. */
export async function loadNonDefaultProfileFrom(
  sources: EffectiveProfileSources,
): Promise<LoadedProfile | undefined> {
  const loaded = await loadProfileFrom(sources);
  const isBuiltInDefault =
    loaded.loadedFrom === null && loaded.digest === profileDigest(DEFAULT_PROFILE);
  return isBuiltInDefault ? undefined : loaded;
}
