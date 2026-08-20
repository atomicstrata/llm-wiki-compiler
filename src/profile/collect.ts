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
import { validateEntityFields } from "./field-contract.js";
import type { ProfilePack, EntityPage, EntityTypeDef } from "./types.js";

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
 * Problem kinds that INVALIDATE a typed page against its profile contract: a
 * page carrying any of these does not satisfy its declared field contract and so
 * must not be promoted as clean agent evidence NOR surfaced as a real graph node.
 * (`field-violation` is the only one a PRODUCED page can carry — a non-slug-safe /
 * slug-mismatch page is dropped by the collector before it becomes a page — but
 * the full set is listed so the exclusion stays correct if the collector ever
 * produces a page despite them.)
 */
const INVALIDATING_PROBLEM_KINDS: ReadonlySet<EntityProblemKind> = new Set([
  "field-violation",
  "non-slug-safe-filename",
  "slug-mismatch",
]);

/**
 * Absolute `filePath`s of every page carrying an invalidating profile-contract
 * problem. SHARED by the context pool ({@link augmentSnapshotWithTypedPages}) and
 * the graph node builder (`collectTypedGraphInputs`) so an invalid typed page is
 * excluded CONSISTENTLY from both — never promoted as clean evidence and never
 * surfaced as a real graph node (it becomes a relation-ghost → `dangling-relation`
 * gap instead).
 *
 * @param problems - The structured problems from {@link collectEntityPages}.
 * @returns The set of absolute file paths to exclude.
 */
export function invalidEntityPagePaths(problems: EntityProblem[]): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const problem of problems) {
    if (problem.filePath !== undefined && INVALIDATING_PROBLEM_KINDS.has(problem.kind)) {
      paths.add(problem.filePath);
    }
  }
  return paths;
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
 * Validate a slug-safe page against its entity type's declared field contract via
 * the SHARED {@link validateEntityFields} (the SAME implementation the typed write
 * gates use), wrapping each PATH-FREE message into a `field-violation` problem
 * tagged with the entity type and the offending `filePath`. The page is NOT
 * dropped — a contract violation is surfaced, not fatal — and this NEVER throws.
 */
function checkFieldContract(
  entityType: string,
  def: EntityTypeDef,
  scan: RawEntityScan,
  problems: EntityProblem[],
): void {
  for (const message of validateEntityFields(scan.frontmatter, def)) {
    problems.push({ kind: "field-violation", entityType, filePath: scan.filePath, message });
  }
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
 * The page's display title, read from the type's DECLARED title field.
 *
 * `EntityTypeDef.titleField` names the frontmatter key a type carries its
 * display name under. It had been in the schema since the profile format
 * shipped and was read by nothing, so a type whose name lives under another key
 * (AutoSci's `people`, keyed `name`) had no title at all and every surface fell
 * back to its slug.
 *
 * Resolved HERE rather than in any one reader, so every surface that renders a
 * display title reads one declaration one way: the viewer, context packs, index
 * generation and the JSON export. A reader-local fix would give a single
 * declaration two meanings.
 *
 * Two surfaces deliberately do NOT consume it, and both say so at their own
 * call site: `empty-page` in lint.ts judges the LITERAL `title` key, because a
 * frontmatter-only record type is not an empty page; and the OKF export carries
 * the literal key too, because publishing the resolved title would ship one
 * value under two keys. `status` reads neither — it counts pages.
 *
 * `undefined` — never `""` — is the answer for anything unusable, because every
 * downstream surface already falls back to the slug on undefined and a blank
 * string would replace that fallback with an empty line.
 *
 * A type declaring NO `titleField` keeps the previous behaviour byte-for-byte,
 * down to `parseStatus.hasTitle`'s non-empty (untrimmed) test. The declared path
 * trims: `"   "` reads as absent rather than as a blank heading, and `"  Ada  "`
 * resolves to `"Ada"` rather than carrying padding into every surface that
 * renders it. The asymmetry is deliberate; the existing path was left as it was.
 *
 * The `string` test is also what confines an inherited name. `titleField` is
 * validated to name a declared own field, but this indexes user-authored
 * frontmatter with a profile-supplied key, and an unvalidated profile reaching
 * here (the SDK, a test) could name `constructor` or `toString` — which resolve
 * off `Object.prototype` to FUNCTIONS, never strings, and so fall out here as
 * absent. An own-property guard would be redundant with it, and no test could
 * tell the two apart.
 */
function pageTitle(def: EntityTypeDef, scan: RawEntityScan): string | undefined {
  if (def.titleField === undefined) {
    return scan.parseStatus.hasTitle ? (scan.frontmatter.title as string) : undefined;
  }
  const declared = scan.frontmatter[def.titleField];
  if (typeof declared !== "string") return undefined;
  const trimmed = declared.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Build a content-carrying `EntityPage` (identity PLUS the scan's
 * `frontmatter`/`body`/`title`) for a valid page, or `null` (with a problem)
 * for an invalid identity. Field-contract violations are surfaced but the page
 * is still produced. Shares all validation with {@link validateScan}.
 *
 * The `title` comes from the type's declared title field — see {@link pageTitle}.
 */
function pageFromScan(
  def: EntityTypeDef,
  entityType: string,
  scan: RawEntityScan,
  problems: EntityProblem[],
): EntityPage | null {
  const stem = validateScan(def, entityType, scan, problems);
  if (stem === null) return null;
  const title = pageTitle(def, scan);
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
 * path exactly), and return this type's VALID-page count plus problems. No
 * content `EntityPage` is ever built or retained.
 *
 * VALID means: slug-safe identity AND no invalidating profile-contract problem
 * (field-violation). Pages with non-slug-safe or slug-mismatch identities are
 * already excluded by `validateScan` returning `null`. Field-violating pages
 * return a non-null stem from `validateScan` but must ALSO be excluded so the
 * count agrees with context and graph (both use `invalidEntityPagePaths`). The
 * invalid pages remain visible via `problems` / `problemTotal`.
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
  // Pages that pass identity validation (non-null stem); a field-violating page
  // is still produced here but excluded below by the SHARED invalidity set.
  const producedPaths: string[] = [];
  for (const scan of scans) {
    if (validateScan(def, entityType, scan, problems) !== null) producedPaths.push(scan.filePath);
  }
  // Count derives from the SAME `invalidEntityPagePaths`/`INVALIDATING_PROBLEM_KINDS`
  // predicate context and graph use, so the three never diverge as problem kinds evolve.
  const invalid = invalidEntityPagePaths(problems);
  return producedPaths.filter((filePath) => !invalid.has(filePath)).length;
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
