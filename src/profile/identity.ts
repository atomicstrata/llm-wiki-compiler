/**
 * Branded identity primitives for profile entity pages.
 *
 * The guiding rule is validate, don't transform: a raw filesystem stem is
 * never silently rewritten into a slug. `stemFromBasename` returns the stem
 * verbatim; only `assertSlugSafe` / `entityId` can produce the branded
 * SlugSafe / EntityId types, and they throw rather than coerce. slugify is
 * applied in exactly one place — `suggestSlugFromBasename` — and only to build
 * a human-friendly hint for error messages, never on the id path.
 */

import path from "path";
import { slugify } from "../utils/markdown.js";
import type { SlugSafe, EntityId } from "./types.js";

/** The slug-safe grammar: lowercase alphanumerics and internal hyphens. */
const SLUG_SAFE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Error raised when an identity primitive is given an invalid value. */
export class EntityIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityIdError";
  }
}

/** Type guard: does `s` match the slug-safe grammar? */
export function isSlugSafe(s: string): s is SlugSafe {
  return SLUG_SAFE_PATTERN.test(s);
}

/**
 * The DEFAULT-page identity floor: is `s` a single safe path component for a
 * default wiki page filename?
 *
 * Distinct from the slug-safe EntityId grammar ({@link isSlugSafe}): default
 * pages keep their Unicode `slugify` stems (e.g. `café-society`, `机器学习`)
 * and, per the Phase-1 invariant, NEVER become EntityIds — so this floor allows
 * Unicode letters/digits/hyphens (whatever `slugify` produces) while still
 * rejecting anything that could escape or hide the file: path separators
 * (`/`, `\`), spaces, the dot-only names `.`/`..`, and a leading-dot (hidden)
 * name. NUL and any other separator-bearing string is rejected by the same
 * separator test (a NUL embeds no separator but a traversal/segment always
 * does); the dot-prefix and empty-string guards cover the remainder.
 */
export function isSafeFilenameComponent(s: string): boolean {
  return s.length > 0 && !/[/\\ \0]/.test(s) && s !== "." && s !== ".." && !s.startsWith(".");
}

/**
 * Assert that `s` is slug-safe, returning it branded as SlugSafe. This is the
 * ONLY way to obtain a SlugSafe value. Throws EntityIdError otherwise.
 */
export function assertSlugSafe(s: string): SlugSafe {
  if (!isSlugSafe(s)) {
    throw new EntityIdError(`Not a slug-safe string: ${JSON.stringify(s)}`);
  }
  return s as SlugSafe;
}

/**
 * Mint an EntityId from an entity type and slug. Both halves must be
 * slug-safe. This is the single mint site for EntityId.
 */
export function entityId(type: string, slug: string): EntityId {
  assertSlugSafe(type);
  assertSlugSafe(slug);
  return `${type}/${slug}` as EntityId;
}

/**
 * Parse an EntityId back into its entity type and slug, splitting on the
 * FIRST slash. BOTH halves are re-validated so the result is fully slug-safe:
 * this is the defense-in-depth floor for hand-built ids (e.g. the executor's
 * `pageRelPath`), so an id like `"../evil"` whose entityType is `..` cannot
 * escape its namespace via `path.join`. An id with no slash, a leading slash
 * (empty entityType), or a non-slug-safe entityType throws EntityIdError.
 */
export function parseEntityId(id: EntityId): { entityType: string; slug: SlugSafe } {
  const firstSlash = id.indexOf("/");
  if (firstSlash < 0) {
    throw new EntityIdError(`Not a <type>/<slug> id: ${JSON.stringify(id)}`);
  }
  const entityType = assertSlugSafe(id.slice(0, firstSlash));
  const slug = assertSlugSafe(id.slice(firstSlash + 1));
  return { entityType, slug };
}

/**
 * The raw stem of a file path: the basename minus a trailing `.md`, returned
 * UNCHANGED. No slugification. Shared by the page collectors.
 */
export function stemFromBasename(filePath: string): string {
  return path.basename(filePath).replace(/\.md$/, "");
}

/**
 * A slugified suggestion derived from a file's basename, for use ONLY in error
 * messages (e.g. "did you mean foo-bar?"). NEVER used on the id path.
 */
export function suggestSlugFromBasename(filePath: string): string {
  return slugify(stemFromBasename(filePath));
}

/**
 * Assert that a declared frontmatter `slug` field, if present, equals the file
 * stem. A mismatch means the page's identity is ambiguous, which is an error.
 */
export function assertSlugMatchesFrontmatter(stem: string, frontmatterSlug?: string): void {
  if (frontmatterSlug !== undefined && frontmatterSlug !== stem) {
    throw new EntityIdError(
      `Declared slug ${JSON.stringify(frontmatterSlug)} does not match file stem ${JSON.stringify(stem)}`,
    );
  }
}
