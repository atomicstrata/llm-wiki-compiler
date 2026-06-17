/**
 * Non-default profile entity-page collector.
 *
 * For a custom (non-default) profile, every entity page's filename stem must
 * be a validated, slug-safe identity — there is no "raw stem" escape hatch as
 * there is on the default path. This module iterates a profile's declared
 * entity types, scans each directory through the SHARED `scanEntityDir`
 * primitive, and per page either mints a branded `EntityId` or records a
 * structured PROBLEM.
 *
 * Honest, graceful read path (problems, not throws):
 *   - the collector NEVER throws on page data — a bad page yields a problem
 *     record and is skipped, while its valid siblings still become refs;
 *   - an INVALID (symlinked / confinement-failed) entity directory is surfaced
 *     as an `invalid-directory` problem — never silently skipped, because the
 *     spec forbids presenting a partial project as healthy;
 *   - a MISSING directory is a benign empty entity type (no problem);
 *   - a non-slug-safe stem → `non-slug-safe-filename` problem (with rename hint);
 *   - a declared frontmatter `slug` that disagrees with the stem →
 *     `slug-mismatch` problem;
 *   - a valid page that violates the declared field contract (a missing
 *     required field, or an enum value outside its declared set) →
 *     `field-violation` problem; the ref is STILL produced.
 *
 * The only thrown error is the `isDefaultProfile` guard — that is a programming
 * error (wrong collector), not page data. Default-profile collection NEVER comes
 * here; it goes through `collectRawWikiPages`, which keeps raw stems.
 */

import { scanEntityDir, type RawEntityScan } from "../wiki/collect.js";
import { isDefaultProfile } from "./default.js";
import { isSlugSafe, entityId, suggestSlugFromBasename } from "./identity.js";
import type {
  ProfilePack,
  EntityPageRef,
  EntityTypeDef,
  FieldDef,
} from "./types.js";

/** Error raised only for the programming-error default-profile guard. */
export class EntityCollectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityCollectError";
  }
}

/** The kinds of structured problem a non-default page/dir can exhibit. */
export type EntityProblemKind =
  | "invalid-directory"
  | "non-slug-safe-filename"
  | "slug-mismatch"
  | "field-violation";

/** A structured, non-fatal problem found while collecting entity pages. */
export interface EntityProblem {
  kind: EntityProblemKind;
  /** The declared entity type the problem belongs to. */
  entityType: string;
  /** Absolute path of the offending page (absent for directory-level problems). */
  filePath?: string;
  /** Human-readable description, safe to surface to agents/users. */
  message: string;
}

/** The graceful result of collecting one profile's entity pages. */
export interface EntityCollectResult {
  refs: EntityPageRef[];
  problems: EntityProblem[];
}

/** Read a declared frontmatter `slug` field as a string, or undefined. */
function declaredSlug(frontmatter: Record<string, unknown>): string | undefined {
  const value = frontmatter.slug;
  return typeof value === "string" ? value : undefined;
}

/**
 * Validate a slug-safe page against its entity type's declared field contract,
 * pushing a `field-violation` problem for each missing required field and each
 * enum field whose present value is outside its declared set. Basic by design:
 * required-present + enum-membership only (no deep type coercion). The ref is
 * NOT dropped — a contract violation is surfaced, not fatal.
 */
function checkFieldContract(
  entityType: string,
  def: EntityTypeDef,
  scan: RawEntityScan,
  problems: EntityProblem[],
): void {
  const fm = scan.frontmatter;
  for (const field of def.requiredFields ?? []) {
    if (!(field in fm)) {
      problems.push({
        kind: "field-violation",
        entityType,
        filePath: scan.filePath,
        message: `Required field ${JSON.stringify(field)} is missing from frontmatter.`,
      });
    }
  }
  for (const [name, fieldDef] of Object.entries(def.fields ?? {})) {
    checkEnumMembership(entityType, name, fieldDef, scan, problems);
  }
}

/** Push a `field-violation` when an enum field's present value is out of set. */
function checkEnumMembership(
  entityType: string,
  name: string,
  fieldDef: FieldDef,
  scan: RawEntityScan,
  problems: EntityProblem[],
): void {
  if (fieldDef.type !== "enum" || !fieldDef.enum) return;
  const value = scan.frontmatter[name];
  if (value === undefined) return;
  if (typeof value !== "string" || !fieldDef.enum.includes(value)) {
    problems.push({
      kind: "field-violation",
      entityType,
      filePath: scan.filePath,
      message:
        `Field ${JSON.stringify(name)} value ${JSON.stringify(value)} is not one of ` +
        `${JSON.stringify(fieldDef.enum)}.`,
    });
  }
}

/**
 * Validate one scanned page. Returns an `EntityPageRef` for a valid (slug-safe,
 * slug-matching) page — and, when the page violates the declared field contract,
 * still returns the ref but appends `field-violation` problems. Returns `null`
 * (and appends a problem) for a non-slug-safe stem or a slug mismatch.
 */
function refFromScan(
  def: EntityTypeDef,
  entityType: string,
  scan: RawEntityScan,
  problems: EntityProblem[],
): EntityPageRef | null {
  const stem = scan.stem;
  if (!isSlugSafe(stem)) {
    problems.push({
      kind: "non-slug-safe-filename",
      entityType,
      filePath: scan.filePath,
      message:
        `Entity page has a non-slug-safe filename; rename it to ` +
        `${JSON.stringify(suggestSlugFromBasename(scan.filePath))} ` +
        `(slug-safe grammar: lowercase alphanumerics and internal hyphens).`,
    });
    return null;
  }
  const declared = declaredSlug(scan.frontmatter);
  if (declared !== undefined && declared !== stem) {
    problems.push({
      kind: "slug-mismatch",
      entityType,
      filePath: scan.filePath,
      message: `Declared slug ${JSON.stringify(declared)} does not match file stem ${JSON.stringify(stem)}.`,
    });
    return null;
  }
  checkFieldContract(entityType, def, scan, problems);
  return { entityType, directory: def.directory, slug: stem, id: entityId(entityType, stem), filePath: scan.filePath };
}

/** Collect one entity type's pages, appending refs and problems in place. */
async function collectOneEntity(
  root: string,
  entityType: string,
  def: EntityTypeDef,
  refs: EntityPageRef[],
  problems: EntityProblem[],
): Promise<void> {
  const { scans, dirStatus } = await scanEntityDir(root, def.directory);
  if (dirStatus === "invalid") {
    problems.push({
      kind: "invalid-directory",
      entityType,
      message:
        `Entity directory ${JSON.stringify(def.directory)} is invalid ` +
        `(a symlink or confinement failure) and was not read.`,
    });
    return;
  }
  for (const scan of scans) {
    const ref = refFromScan(def, entityType, scan, problems);
    if (ref) refs.push(ref);
  }
}

/**
 * Collect every entity page for a NON-DEFAULT profile as strict
 * `EntityPageRef`s with branded `EntityId`s, alongside any structured problems.
 * Iterates the profile's declared entity types, scanning each through the shared
 * `scanEntityDir`. One bad page or directory never stops the others.
 *
 * @param root - Absolute project root directory.
 * @param profile - A non-default profile pack. Passing the default profile is a
 *   programming error and throws (the only thrown case).
 * @returns `{ refs, problems }` — one ref per valid page, plus a problem per
 *   invalid directory / bad page / field-contract violation.
 * @throws {EntityCollectError} ONLY when the default profile is passed.
 */
export async function collectEntityPages(
  root: string,
  profile: ProfilePack,
): Promise<EntityCollectResult> {
  if (isDefaultProfile(profile)) {
    throw new EntityCollectError(
      "collectEntityPages is for non-default profiles only; use collectRawWikiPages for the default profile.",
    );
  }
  const refs: EntityPageRef[] = [];
  const problems: EntityProblem[] = [];
  for (const [entityType, def] of Object.entries(profile.entities) as [string, EntityTypeDef][]) {
    await collectOneEntity(root, entityType, def, refs, problems);
  }
  return { refs, problems };
}
