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
import type { JsonExportProfileBlock, RelationView } from "./json-export.js";
import type { LoadedProfile } from "../profile/types.js";
import { readRelations } from "../relations/store-read.js";
import { RelationStoreCorruptError, RelationStoreTooNewError } from "../relations/types.js";
import type { RelationRef } from "../relations/types.js";

/**
 * Map an internal {@link RelationRef} to its public, path-safe {@link RelationView}:
 * carry the EntityId endpoints (already opaque, not paths) and the typed
 * attributes + content hash, and DROP `evidence` (whose citations carry source
 * paths) so the export never leaks a filesystem path through a relation.
 */
function toRelationView(ref: RelationRef): RelationView {
  return { id: ref.id, type: ref.type, from: ref.from, to: ref.to, attributes: ref.attributes, contentHash: ref.contentHash };
}

/**
 * Read the live relation store for the export, returning path-safe views ONLY
 * when the store holds relations. A relation-less profile yields `undefined`
 * (no `relations` key, so the export stays byte-identical); a fail-closed read
 * (corrupt / too-new) also yields `undefined` rather than partial relations —
 * lint is the surface that reports a broken store.
 */
async function exportRelationViews(root: string, loaded: LoadedProfile): Promise<RelationView[] | undefined> {
  if (loaded.profile.relations === undefined) return undefined;
  try {
    const { relations } = await readRelations(root);
    return relations.length > 0 ? relations.map(toRelationView) : undefined;
  } catch (error) {
    if (error instanceof RelationStoreCorruptError || error instanceof RelationStoreTooNewError) return undefined;
    throw error;
  }
}

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
  const { pages, problems } = await collectEntityPagesWithMessages(root, loaded);
  const relations = await exportRelationViews(root, loaded);
  return {
    version: PROFILE_BLOCK_VERSION,
    profileId: loaded.profile.profileId,
    entityPages: pages.map((page) => toEntityPageView(page, true)),
    ...(problems.length > 0 ? { problems, problemTotal: problems.length } : {}),
    ...(relations ? { relations } : {}),
  };
}
