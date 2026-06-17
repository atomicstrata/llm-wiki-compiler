/**
 * Additive profile entity block for the JSON export.
 *
 * Mirrors the `status`/`listPages` additive-block pattern: for the built-in
 * default profile this returns `undefined` so the default export envelope is
 * byte-identical, and ONLY for a non-default profile does it assemble a
 * `JsonExportProfileBlock` carrying the content-bearing `EntityPage`s from the
 * shared collector. The built-in is detected by `loadedFrom === null` (never by
 * profileId), with a digest cross-check as defense-in-depth.
 */

import { loadProfile } from "../profile/load.js";
import { collectEntityPages } from "../profile/collect.js";
import { DEFAULT_PROFILE } from "../profile/default.js";
import { profileDigest } from "../profile/digest.js";
import type { JsonExportProfileBlock } from "./json-export.js";

/**
 * Build the additive JSON-export profile block for a project root.
 *
 * @param root - Absolute project root directory.
 * @returns The profile block for a non-default profile, or `undefined` for the
 *   built-in default so the export gains no `profile` key.
 */
export async function buildExportProfileBlock(
  root: string,
): Promise<JsonExportProfileBlock | undefined> {
  const loaded = await loadProfile(root);
  const isBuiltInDefault =
    loaded.loadedFrom === null && loaded.digest === profileDigest(DEFAULT_PROFILE);
  if (isBuiltInDefault) return undefined;
  const { pages, problems } = await collectEntityPages(root, loaded.profile);
  const messages = problems.map((p) => p.message);
  return {
    profileId: loaded.profile.profileId,
    entityPages: pages,
    ...(messages.length > 0 ? { problems: messages } : {}),
  };
}
