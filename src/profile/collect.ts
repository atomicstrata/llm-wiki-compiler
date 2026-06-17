/**
 * Non-default profile entity-page collector.
 *
 * For a custom (non-default) profile, every entity page's filename stem must
 * be a validated, slug-safe identity — there is no "raw stem" escape hatch as
 * there is on the default path. This module iterates a profile's declared
 * entity types, scans each directory through the SHARED `scanEntityDir`
 * primitive, and per page either mints a branded `EntityId` or FAILS CLOSED.
 *
 * Fail-closed rules (validate, don't transform):
 *   - a stem that is not slug-safe is a hard error naming the offending file
 *     and the `suggestSlugFromBasename` rename target — never silently
 *     slugified, never silently skipped;
 *   - a declared frontmatter `slug` that disagrees with the file stem is a
 *     hard error (ambiguous identity).
 *
 * Default-profile collection NEVER comes here — it goes through
 * `collectRawWikiPages`, which keeps raw stems and mints no ids. This function
 * asserts `!isDefaultProfile(profile)` and throws if violated.
 */

import { scanEntityDir, type RawEntityScan } from "../wiki/collect.js";
import { isDefaultProfile } from "./default.js";
import {
  isSlugSafe,
  entityId,
  suggestSlugFromBasename,
  assertSlugMatchesFrontmatter,
} from "./identity.js";
import type { ProfilePack, EntityPageRef, EntityTypeDef } from "./types.js";

/** Error raised when a non-default entity page's identity is invalid. */
export class EntityCollectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityCollectError";
  }
}

/** Read a declared frontmatter `slug` field as a string, or undefined. */
function declaredSlug(frontmatter: Record<string, unknown>): string | undefined {
  const value = frontmatter.slug;
  return typeof value === "string" ? value : undefined;
}

/**
 * Validate one scanned page and turn it into a strict `EntityPageRef`. Fails
 * closed when the stem is not slug-safe (naming the rename hint) or when a
 * declared frontmatter slug disagrees with the stem.
 */
function refFromScan(entityType: string, directory: string, scan: RawEntityScan): EntityPageRef {
  const stem = scan.stem;
  if (!isSlugSafe(stem)) {
    throw new EntityCollectError(
      `Entity page ${JSON.stringify(scan.filePath)} has a non-slug-safe filename; ` +
        `rename it to ${JSON.stringify(suggestSlugFromBasename(scan.filePath))} ` +
        `(slug-safe grammar: lowercase alphanumerics and internal hyphens).`,
    );
  }
  assertSlugMatchesFrontmatter(stem, declaredSlug(scan.frontmatter));
  return { entityType, directory, slug: stem, id: entityId(entityType, stem), filePath: scan.filePath };
}

/**
 * Collect every entity page for a NON-DEFAULT profile as strict
 * `EntityPageRef`s with branded `EntityId`s. Iterates the profile's declared
 * entity types, scanning each through the shared `scanEntityDir`.
 *
 * @param root - Absolute project root directory.
 * @param profile - A non-default profile pack. Passing the default profile is a
 *   programming error and throws.
 * @returns One `EntityPageRef` per readable, slug-safe entity page.
 * @throws {EntityCollectError} When the default profile is passed, or when any
 *   page's filename stem is not slug-safe, or a declared slug mismatches.
 */
export async function collectEntityPages(root: string, profile: ProfilePack): Promise<EntityPageRef[]> {
  if (isDefaultProfile(profile)) {
    throw new EntityCollectError(
      "collectEntityPages is for non-default profiles only; use collectRawWikiPages for the default profile.",
    );
  }
  const refs: EntityPageRef[] = [];
  for (const [entityType, def] of Object.entries(profile.entities) as [string, EntityTypeDef][]) {
    const scans = await scanEntityDir(root, entityType, def.directory);
    for (const scan of scans) refs.push(refFromScan(entityType, def.directory, scan));
  }
  return refs;
}
