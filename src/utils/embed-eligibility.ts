/**
 * Pure embedding-eligibility predicate (spec §4.2).
 *
 * Decides whether a page is embedded and on which surfaces (search / context)
 * based on its metadata, its page kind, an optional typed `RetrievalDef`, and
 * a profile-validity flag. PURE: no filesystem access, no profile reads —
 * all inputs are supplied by the caller.
 *
 * Truth table (tri-state: omitted ≡ ≠ false):
 *   embedded  iff  includeInSearch !== false  OR  includeInContext !== false
 *   inSearch  iff  includeInSearch !== false
 *   inContext iff  includeInContext !== false
 *
 * Additional gates:
 *   - Concepts/queries: legacy skip (codex#4) — orphaned or non-string title → not embedded.
 *   - Typed pages: profile-invalid (field-violation / bad slug) → not embedded.
 */

import type { RetrievalDef } from "../profile/types.js";

/** Embedding surface flags for a single page. */
export interface EmbedSurfaces {
  /** True if the page should be represented in the embedding store at all. */
  embedded: boolean;
  /** True if the page contributes to semantic search results. */
  inSearch: boolean;
  /** True if the page may be injected into an agent's context pack. */
  inContext: boolean;
}

/** Input for a concept or query page (no `RetrievalDef` — defaults to both eligible). */
export interface ConceptPageInput {
  meta: Record<string, unknown>;
  pageKind: "concept" | "query";
}

/** Input for a typed entity page (has a `RetrievalDef` + profile-validity flag). */
export interface TypedPageInput {
  meta: Record<string, unknown>;
  pageKind: "typed";
  /** The entity type's declared retrieval settings; `undefined` when the type has no retrieval block. */
  retrieval: RetrievalDef | undefined;
  /** True when the page carries an invalidating profile-contract problem (field-violation, bad slug). */
  isProfileInvalid: boolean;
}

export type EmbedEligibilityInput = ConceptPageInput | TypedPageInput;

/** The ineligible result — shared constant to avoid allocating identical objects. */
const NOT_EMBEDDED: EmbedSurfaces = { embedded: false, inSearch: false, inContext: false };

/** Build surfaces from a `RetrievalDef` (or undefined defaults) via the §4.2 truth table. */
function surfacesFromRetrieval(retrieval: RetrievalDef | undefined): EmbedSurfaces {
  const inSearch = retrieval?.includeInSearch !== false;
  const inContext = retrieval?.includeInContext !== false;
  return { embedded: inSearch || inContext, inSearch, inContext };
}

/** Legacy gate (codex#4): a concept/query must be live + titled to be embedded. */
function isLegacyEligible(meta: Record<string, unknown>): boolean {
  return meta.orphaned !== true && typeof meta.title === "string";
}

/**
 * Determine embedding surfaces for a page given its metadata and kind.
 *
 * @param input - Pre-collected page metadata, kind, and (for typed pages)
 *   `RetrievalDef` + profile-validity.
 * @returns `{ embedded, inSearch, inContext }` per spec §4.2.
 */
export function pageEmbedSurfaces(input: EmbedEligibilityInput): EmbedSurfaces {
  if (input.pageKind === "typed") {
    if (input.isProfileInvalid) return NOT_EMBEDDED;
    return surfacesFromRetrieval(input.retrieval);
  }
  // concept / query — legacy gate first, then default to both surfaces
  if (!isLegacyEligible(input.meta)) return NOT_EMBEDDED;
  return { embedded: true, inSearch: true, inContext: true };
}
