/**
 * Profile-aware lint findings over non-default entity pages.
 *
 * For a custom (non-default) profile, `lintProfileEntities` runs
 * `collectEntityPages` and surfaces its two output channels as `LintResult`s,
 * ADDITIVELY — nothing here touches the default lint path or its frozen golden:
 *
 *   1. Every structured `EntityProblem` becomes a `LintResult`. The three
 *      identity/structure problems (`invalid-directory`,
 *      `non-slug-safe-filename`, `slug-mismatch`) are `error`s; a
 *      `field-violation` (a contract breach on an otherwise-readable page) is a
 *      `warning`. Each maps to a stable `profile/<kind>` rule id.
 *
 *   2. A CONSERVATIVE subset of the default content rules then runs over each
 *      collected `EntityPage`. Only checks that need nothing but a page's
 *      `{ filePath, body, title }` and assume nothing about concepts/queries
 *      semantics, the schema, or source ownership are included — see
 *      {@link lintEntityPageContent}.
 *
 * Every finding carries the offending page/dir's `entityType` so callers can
 * group diagnostics by entity type.
 */

import { collectEntityPages, type EntityProblem, type EntityProblemKind } from "./collect.js";
import { checkPageEmpty, checkPageMalformedCitations } from "../linter/rules.js";
import { lifecycleStateSet } from "./lifecycle.js";
import type { ProfilePack, EntityPage, LifecycleDef } from "./types.js";
import type { LintResult } from "../linter/types.js";

/** Rule id for a typed entity page whose lifecycle-field value is off the FSM. */
const INVALID_LIFECYCLE_STATE_RULE = "invalid-lifecycle-state";

/** Severity for each problem kind: identity/structure errors, contract warnings. */
const PROBLEM_SEVERITY: Record<EntityProblemKind, LintResult["severity"]> = {
  "invalid-directory": "error",
  "non-slug-safe-filename": "error",
  "slug-mismatch": "error",
  "field-violation": "warning",
};

/**
 * Map one structured collector problem to a `LintResult`. The `file` is the
 * offending page path; an `invalid-directory` problem has no page path, so it
 * falls back to the entity-type label so the finding is never file-less.
 */
function problemToResult(problem: EntityProblem): LintResult {
  return {
    rule: `profile/${problem.kind}`,
    severity: PROBLEM_SEVERITY[problem.kind],
    file: problem.filePath ?? problem.entityType,
    message: problem.message,
    entityType: problem.entityType,
  };
}

/**
 * Run the profile-SAFE, content-generic default rules over one entity page.
 *
 * Included (and why each is safe — needs only file + body/title, assumes
 * nothing about concepts/queries, the schema, or source state):
 *   - `empty-page` — a titled page with a near-empty body is a universal
 *     content-quality signal, independent of entity semantics.
 *   - `malformed-claim-citation` — pure grammar check of any `^[...]` markers
 *     in the body; flags only structurally malformed entries and never
 *     consults the schema, other pages, or whether the cited source exists.
 *
 * Deliberately EXCLUDED: schema-cross-link (needs the schema), stale/orphaned
 * (need source/freshness state), duplicate-concept and broken-wikilink (need
 * the concepts/queries page set), broken-citation (needs the sources/ dir),
 * and the confidence/contradiction/inferred rules (assume default frontmatter
 * provenance). Applying any of those to arbitrary entity pages would misreport.
 *
 * Each finding is tagged with the page's `entityType`.
 */
function lintEntityPageContent(page: EntityPage): LintResult[] {
  const findings = [
    ...checkPageEmpty({ title: page.title, body: page.body, filePath: page.filePath }),
    ...checkPageMalformedCitations(page.body, page.filePath),
  ];
  return findings.map((finding) => ({ ...finding, entityType: page.entityType }));
}

/**
 * Flag a typed entity page whose lifecycle-field value is NOT a declared state of
 * its entity type's lifecycle as an `invalid-lifecycle-state` warning. An entity
 * type with no `lifecycle`, or a page whose lifecycle field is absent (the field
 * is optional), yields no finding — so the default/concepts path (no lifecycle)
 * stays byte-identical.
 *
 * @param page - The collected entity page to check.
 * @param lifecycle - The entity type's lifecycle, or `undefined` when it has none.
 * @returns A single-element finding array, or an empty array when on-FSM.
 */
function checkLifecycleStates(page: EntityPage, lifecycle?: LifecycleDef): LintResult[] {
  if (!lifecycle) return [];
  const value = page.frontmatter[lifecycle.field];
  if (value === undefined) return [];
  if (typeof value === "string" && lifecycleStateSet(lifecycle).has(value)) return [];
  return [{
    rule: INVALID_LIFECYCLE_STATE_RULE,
    severity: "warning",
    file: page.filePath,
    message: `lifecycle field ${JSON.stringify(lifecycle.field)} value ${JSON.stringify(value)} is not a declared state`,
    entityType: page.entityType,
  }];
}

/**
 * Surface a non-default profile's entity-page issues as `LintResult`s,
 * additively. Collects the profile's entity pages, maps every structured
 * problem to a finding (correct severity per {@link PROBLEM_SEVERITY}), then
 * runs the profile-safe content rules and the lifecycle-state check over each
 * collected page.
 *
 * @param root - Absolute project root directory.
 * @param profile - A NON-default profile pack (the default profile has no
 *   entity-collection path; callers gate on `isDefaultProfile` before calling).
 * @returns All profile-aware findings, each tagged with its `entityType`.
 */
export async function lintProfileEntities(
  root: string,
  profile: ProfilePack,
): Promise<LintResult[]> {
  const { pages, problems } = await collectEntityPages(root, profile);
  const results: LintResult[] = problems.map(problemToResult);
  for (const page of pages) {
    results.push(...lintEntityPageContent(page));
    results.push(...checkLifecycleStates(page, profile.entities[page.entityType]?.lifecycle));
  }
  return results;
}
