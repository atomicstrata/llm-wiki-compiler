/**
 * Additive profile entity block for the JSON export.
 *
 * Mirrors the `status`/`listPages` additive-block pattern: for the built-in
 * default profile this returns `undefined` so the default export envelope is
 * byte-identical, and ONLY for a non-default profile does it assemble a
 * `JsonExportProfileBlock` carrying the content-bearing `EntityPage`s from the
 * shared collector. The built-in is gated through the shared
 * {@link loadNonDefaultProfile} primitive.
 */

import { loadNonDefaultProfile, collectEntityPagesWithMessages } from "../profile/block.js";
import { toEntityPageView } from "../profile/types.js";
import { PROFILE_BLOCK_VERSION } from "./json-export.js";
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
  const loaded = await loadNonDefaultProfile(root);
  if (loaded === undefined) return undefined;
  const { pages, messages } = await collectEntityPagesWithMessages(root, loaded);
  return {
    version: PROFILE_BLOCK_VERSION,
    profileId: loaded.profile.profileId,
    entityPages: pages.map((page) => toEntityPageView(page, true)),
    ...(messages.length > 0 ? { problems: messages } : {}),
  };
}
