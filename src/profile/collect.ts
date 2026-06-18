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
 *     record and is skipped, while its valid siblings still become pages;
 *   - an INVALID (symlinked / confinement-failed) entity directory is surfaced
 *     as an `invalid-directory` problem — never silently skipped, because the
 *     spec forbids presenting a partial project as healthy;
 *   - a MISSING directory is a benign empty entity type (no problem);
 *   - a non-slug-safe stem → `non-slug-safe-filename` problem (with rename hint);
 *   - a declared frontmatter `slug` that disagrees with the stem →
 *     `slug-mismatch` problem;
 *   - a valid page that violates the declared field contract (a missing
 *     required field, or an enum value outside its declared set) →
 *     `field-violation` problem; the page is STILL produced.
 *
 * The only thrown error is the `isDefaultProfile` guard — that is a programming
 * error (wrong collector), not page data. Default-profile collection NEVER comes
 * here; it goes through `collectRawWikiPages`, which keeps raw stems.
 */

import { scanEntityDir, type RawEntityScan } from "../wiki/collect.js";
import { isDefaultProfile } from "./default.js";
import { isSlugSafe, assertSlugSafe, entityId, suggestSlugFromBasename } from "./identity.js";
import type {
  ProfilePack,
  EntityPage,
  EntityTypeDef,
  FieldDef,
  FieldType,
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
  pages: EntityPage[];
  problems: EntityProblem[];
}

/**
 * The count-only result of summarizing a profile's entity pages: per-type
 * counts plus problems, with NO content `EntityPage[]` retained. Produced by
 * {@link collectEntitySummary} for surfaces (status, viewer) that only tally.
 */
export interface EntitySummaryResult {
  counts: Record<string, number>;
  problems: EntityProblem[];
}

/** Read a declared frontmatter `slug` field as a string, or undefined. */
function declaredSlug(frontmatter: Record<string, unknown>): string | undefined {
  const value = frontmatter.slug;
  return typeof value === "string" ? value : undefined;
}

/**
 * Validate a slug-safe page against its entity type's declared field contract,
 * pushing a `field-violation` problem for each missing required field and, for
 * each PRESENT field value, every declared-type / enum / min-max mismatch. The
 * page is NOT dropped — a contract violation is surfaced, not fatal — and this
 * NEVER throws. Messages are PATH-FREE (the offending path lives only on the
 * structured `filePath` field).
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
    checkFieldValue(entityType, name, fieldDef, scan, problems);
  }
}

/**
 * Validate one present field value against its declared type, enum membership,
 * and numeric min/max. A missing value is not validated here (required-presence
 * is handled separately). Each mismatch becomes one PATH-FREE `field-violation`.
 */
function checkFieldValue(
  entityType: string,
  name: string,
  fieldDef: FieldDef,
  scan: RawEntityScan,
  problems: EntityProblem[],
): void {
  const value = scan.frontmatter[name];
  if (value === undefined) return;
  const typeError = describeTypeMismatch(name, fieldDef, value);
  if (typeError) {
    pushFieldViolation(entityType, scan.filePath, typeError, problems);
    return;
  }
  const rangeError = describeRangeViolation(name, fieldDef, value);
  if (rangeError) pushFieldViolation(entityType, scan.filePath, rangeError, problems);
}

/** Append a `field-violation` problem carrying a PATH-FREE message. */
function pushFieldViolation(
  entityType: string,
  filePath: string,
  message: string,
  problems: EntityProblem[],
): void {
  problems.push({ kind: "field-violation", entityType, filePath, message });
}

/**
 * Return a PATH-FREE message when `value` does not match `fieldDef.type`
 * (including enum membership), or `undefined` when the type is satisfied.
 */
function describeTypeMismatch(name: string, fieldDef: FieldDef, value: unknown): string | undefined {
  if (matchesDeclaredType(fieldDef, value)) return undefined;
  if (fieldDef.type === "enum") {
    return (
      `Field ${JSON.stringify(name)} value ${JSON.stringify(value)} is not one of ` +
      `${JSON.stringify(fieldDef.enum ?? [])}.`
    );
  }
  return `Field ${JSON.stringify(name)} value ${JSON.stringify(value)} is not a valid ${fieldDef.type}.`;
}

/** True when `value` is a string parseable as a date, or a valid `Date`. */
function isValidDate(value: unknown): boolean {
  // YAML parses an unquoted ISO date into a JS `Date`; a quoted value stays a
  // string. Accept either, provided it denotes a valid instant.
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * Per-field-type value predicates (enum excluded — it needs the `FieldDef`).
 * A lookup table keeps {@link matchesDeclaredType} flat instead of a wide
 * switch that would trip the complexity gate.
 */
const TYPE_PREDICATES: Record<Exclude<FieldType, "enum">, (value: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  slug: (v) => typeof v === "string",
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  date: isValidDate,
  "string[]": (v) => Array.isArray(v) && v.every((item) => typeof item === "string"),
};

/** True when `value` satisfies the declared `FieldDef.type` (enum included). */
function matchesDeclaredType(fieldDef: FieldDef, value: unknown): boolean {
  if (fieldDef.type === "enum") {
    return typeof value === "string" && (fieldDef.enum?.includes(value) ?? false);
  }
  return TYPE_PREDICATES[fieldDef.type](value);
}

/**
 * Return a PATH-FREE message when a numeric `value` falls outside the declared
 * `[min, max]`, or `undefined` when in range or when no bound applies. Only
 * meaningful after the value has passed its numeric type check.
 */
function describeRangeViolation(name: string, fieldDef: FieldDef, value: unknown): string | undefined {
  if (typeof value !== "number") return undefined;
  if (fieldDef.min !== undefined && value < fieldDef.min) {
    return `Field ${JSON.stringify(name)} value ${value} is below min ${fieldDef.min}.`;
  }
  if (fieldDef.max !== undefined && value > fieldDef.max) {
    return `Field ${JSON.stringify(name)} value ${value} exceeds max ${fieldDef.max}.`;
  }
  return undefined;
}

/**
 * Validate one scanned page's IDENTITY and field contract, appending problems.
 * Returns the validated stem for a slug-safe, slug-matching page (still
 * returned even when it carries `field-violation` problems), or `null` (with a
 * `non-slug-safe-filename` or `slug-mismatch` problem) for an invalid identity.
 *
 * This is the SINGLE per-scan validation used by both the content collector
 * ({@link pageFromScan}) and the count-only summary, so the two never drift.
 */
function validateScan(
  def: EntityTypeDef,
  entityType: string,
  scan: RawEntityScan,
  problems: EntityProblem[],
): string | null {
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
  return stem;
}

/**
 * Build a content-carrying `EntityPage` (identity PLUS the scan's
 * `frontmatter`/`body`/`title`) for a valid page, or `null` (with a problem)
 * for an invalid identity. Field-contract violations are surfaced but the page
 * is still produced. Shares all validation with {@link validateScan}.
 *
 * The `title` is the frontmatter title only when the scan flagged one present
 * (`parseStatus.hasTitle`); otherwise it is `undefined`.
 */
function pageFromScan(
  def: EntityTypeDef,
  entityType: string,
  scan: RawEntityScan,
  problems: EntityProblem[],
): EntityPage | null {
  const stem = validateScan(def, entityType, scan, problems);
  if (stem === null) return null;
  const title = scan.parseStatus.hasTitle ? (scan.frontmatter.title as string) : undefined;
  return {
    entityType,
    directory: def.directory,
    slug: assertSlugSafe(stem),
    id: entityId(entityType, stem),
    filePath: scan.filePath,
    frontmatter: scan.frontmatter,
    body: scan.body,
    title,
  };
}

/** Push the shared `invalid-directory` problem for a symlinked/confined-out dir. */
function pushInvalidDirectory(
  entityType: string,
  def: EntityTypeDef,
  problems: EntityProblem[],
): void {
  problems.push({
    kind: "invalid-directory",
    entityType,
    message:
      `Entity directory ${JSON.stringify(def.directory)} is invalid ` +
      `(a symlink or confinement failure) and was not read.`,
  });
}

/** Collect one entity type's pages, appending pages and problems in place. */
async function collectOneEntity(
  root: string,
  entityType: string,
  def: EntityTypeDef,
  pages: EntityPage[],
  problems: EntityProblem[],
): Promise<void> {
  const { scans, dirStatus } = await scanEntityDir(root, def.directory);
  if (dirStatus === "invalid") {
    pushInvalidDirectory(entityType, def, problems);
    return;
  }
  for (const scan of scans) {
    const page = pageFromScan(def, entityType, scan, problems);
    if (page) pages.push(page);
  }
}

/**
 * Summarize one entity type metadata-only: scan WITHOUT bodies, validate each
 * scan through the SHARED {@link validateScan} (so problems match the content
 * path exactly), and return this type's valid-page count plus problems. No
 * content `EntityPage` is ever built or retained.
 */
async function summarizeOneEntity(
  root: string,
  entityType: string,
  def: EntityTypeDef,
  problems: EntityProblem[],
): Promise<number> {
  const { scans, dirStatus } = await scanEntityDir(root, def.directory, { includeBody: false });
  if (dirStatus === "invalid") {
    pushInvalidDirectory(entityType, def, problems);
    return 0;
  }
  let count = 0;
  for (const scan of scans) {
    if (validateScan(def, entityType, scan, problems) !== null) count += 1;
  }
  return count;
}

/**
 * Collect every entity page for a NON-DEFAULT profile as content-carrying
 * `EntityPage`s (branded `EntityId` identity PLUS frontmatter/body/title),
 * alongside any structured problems. Iterates the profile's declared entity
 * types, scanning each through the shared `scanEntityDir`. One bad page or
 * directory never stops the others.
 *
 * @param root - Absolute project root directory.
 * @param profile - A non-default profile pack. Passing the default profile is a
 *   programming error and throws (the only thrown case).
 * @returns `{ pages, problems }` — one page per valid page (with its content),
 *   plus a problem per invalid directory / bad page / field-contract violation.
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
  const pages: EntityPage[] = [];
  const problems: EntityProblem[] = [];
  for (const [entityType, def] of Object.entries(profile.entities) as [string, EntityTypeDef][]) {
    await collectOneEntity(root, entityType, def, pages, problems);
  }
  return { pages, problems };
}

/**
 * Summarize a NON-DEFAULT profile's entity pages metadata-only: per-entity-type
 * valid-page counts plus the same structured problems {@link collectEntityPages}
 * would surface — WITHOUT building or retaining any content `EntityPage`. Used
 * by count-only read surfaces (status, viewer) so they no longer hold every
 * page's body in memory just to tally and validate.
 *
 * Counts seed every declared entity type at zero (a declared-but-empty type
 * still reports `0`), then add one per valid page. Problems are identical to the
 * content path because both share {@link validateScan}.
 *
 * @param root - Absolute project root directory.
 * @param profile - A non-default profile pack. Passing the default profile is a
 *   programming error and throws (the only thrown case).
 * @returns `{ counts, problems }` — no page objects, no bodies.
 * @throws {EntityCollectError} ONLY when the default profile is passed.
 */
export async function collectEntitySummary(
  root: string,
  profile: ProfilePack,
): Promise<EntitySummaryResult> {
  if (isDefaultProfile(profile)) {
    throw new EntityCollectError(
      "collectEntitySummary is for non-default profiles only; use collectRawWikiPages for the default profile.",
    );
  }
  const counts: Record<string, number> = {};
  const problems: EntityProblem[] = [];
  for (const [entityType, def] of Object.entries(profile.entities) as [string, EntityTypeDef][]) {
    counts[entityType] = await summarizeOneEntity(root, entityType, def, problems);
  }
  return { counts, problems };
}
