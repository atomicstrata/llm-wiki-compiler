/**
 * Lossless v1→v2 migration for the persisted `.llmwiki/state.json` WikiState.
 *
 * Phase 2 of the Configurable Lifecycle Knowledge Platform adds a typed
 * ownership mirror to the incremental state: alongside the v1 string lists
 * (`SourceState.concepts`, `WikiState.frozenSlugs`) the migrated v2 state
 * carries branded `concepts/<slug>` {@link EntityId}s in `entities` /
 * `frozenEntities`. The v1 fields are preserved verbatim, so the upgrade is
 * lossless and the state remains downgradeable.
 *
 * Three invariants are load-bearing for callers:
 *  - idempotent: a `version: 2` state is returned unchanged, so re-running the
 *    migration never double-types a slug (no `concepts/concepts/rag`);
 *  - deterministic: minted id arrays are sorted lexicographically so repeated
 *    migrations of equal inputs serialise byte-for-byte identically;
 *  - tolerant: slug-safe slugs are typed; non-slug-safe slugs (e.g. the Unicode
 *    stems `slugify` keeps, like `café-society` / `机器学习`) are kept in the
 *    verbatim `concepts` / `frozenSlugs` mirror WITHOUT a typed id, so a
 *    mixed-language wiki migrates instead of aborting. Widening the EntityId
 *    grammar to cover Unicode is a deferred identity change, not done here.
 */

import { entityId, isSlugSafe } from "../profile/identity.js";
import type { EntityId } from "../profile/types.js";
import type { SourceState, WikiState } from "../utils/types.js";

/** The single entity type owned by the compiler's incremental state. */
const CONCEPT_ENTITY_TYPE = "concepts";

/**
 * Mint a sorted, deduplicated list of `concepts/<slug>` EntityIds from bare
 * concept slugs. Tolerant: only slug-safe slugs are typed; any slug that fails
 * {@link isSlugSafe} (e.g. a Unicode stem) is SKIPPED here and survives via the
 * verbatim `concepts` / `frozenSlugs` mirror it was drawn from. This is the
 * single grammar/skip site, shared by migration and the writeState mirror sync.
 */
export function mintConceptEntities(slugs: string[]): EntityId[] {
  const ids = slugs
    .filter((slug) => isSlugSafe(slug))
    .map((slug) => entityId(CONCEPT_ENTITY_TYPE, slug));
  return [...new Set(ids)].sort();
}

/** Upgrade a single source entry, adding its typed `entities` mirror. */
function migrateSource(source: SourceState): SourceState {
  return { ...source, entities: mintConceptEntities(source.concepts) };
}

/** Apply {@link migrateSource} across every source, preserving keys. */
function migrateSources(
  sources: Record<string, SourceState>,
): Record<string, SourceState> {
  const out: Record<string, SourceState> = {};
  for (const [file, source] of Object.entries(sources)) {
    out[file] = migrateSource(source);
  }
  return out;
}

/**
 * Migrate a WikiState to v2, adding the typed-ownership mirror to every source
 * and to the frozen-slug set while carrying all v1 fields through unchanged.
 * Returns the state untouched when it is already v2-or-newer (idempotent): the
 * `>= 2` gate is defensive against re-typing an already-typed state.
 */
export function migrateStateToV2(state: WikiState): WikiState {
  if (state.version >= 2) {
    return state;
  }
  return {
    ...state,
    version: 2,
    sources: migrateSources(state.sources),
    frozenEntities: mintConceptEntities(state.frozenSlugs ?? []),
  };
}
