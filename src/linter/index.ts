/**
 * Wiki linter orchestrator.
 *
 * Imports all lint rules, runs them concurrently, and aggregates
 * results into a summary with error/warning/info counts.
 * This is the main entry point for programmatic lint access.
 */

import type { LintResult, LintRule, LintSummary, SchemaAwareLintRule } from "./types.js";
import {
  checkBrokenWikilinks,
  checkOrphanedPages,
  checkMissingSummaries,
  checkDuplicateConcepts,
  checkEmptyPages,
  checkBrokenCitations,
  checkMalformedClaimCitations,
  checkLowConfidencePages,
  checkContradictedPages,
  checkInferredWithoutCitations,
  checkSchemaCrossLinks,
  checkStalePages,
} from "./rules.js";
import path from "path";
import { loadSchema } from "../schema/index.js";
import { buildFreshnessSnapshot } from "../freshness/index.js";
import type { FreshnessSnapshot } from "../freshness/types.js";
import { appendLog, formatWikilinkList } from "../utils/activity-log.js";

/** Rule-only lint checks that don't depend on the schema layer. */
const RULES_WITHOUT_SCHEMA: LintRule[] = [
  checkBrokenWikilinks,
  checkOrphanedPages,
  checkMissingSummaries,
  checkDuplicateConcepts,
  checkEmptyPages,
  checkBrokenCitations,
  checkMalformedClaimCitations,
  checkLowConfidencePages,
  checkContradictedPages,
  checkInferredWithoutCitations,
];

/** Lint rules that need the resolved schema to know per-kind expectations. */
const RULES_WITH_SCHEMA: SchemaAwareLintRule[] = [checkSchemaCrossLinks];

type FreshnessLintRule = (root: string, snapshot: FreshnessSnapshot) => Promise<LintResult[]>;
const RULES_WITH_FRESHNESS: FreshnessLintRule[] = [checkStalePages];

/**
 * Count occurrences of a specific severity level in the results.
 */
function countBySeverity(
  results: LintResult[],
  severity: LintResult["severity"],
): number {
  return results.filter((r) => r.severity === severity).length;
}

/**
 * Run all lint rules concurrently against the wiki at the given root.
 * Loads the project schema (or defaults) so schema-aware rules can enforce
 * per-kind cross-link minimums alongside structural checks.
 * @param root - Absolute path to the project root directory.
 * @returns A summary containing all diagnostics and severity counts.
 */
export async function lint(root: string): Promise<LintSummary> {
  const schema = await loadSchema(root);
  const freshness = await buildFreshnessSnapshot(root);
  const [plainResults, schemaResults, freshnessResults] = await Promise.all([
    Promise.all(RULES_WITHOUT_SCHEMA.map((rule) => rule(root))),
    Promise.all(RULES_WITH_SCHEMA.map((rule) => rule(root, schema))),
    Promise.all(RULES_WITH_FRESHNESS.map((rule) => rule(root, freshness))),
  ]);

  const results = [...plainResults.flat(), ...schemaResults.flat(), ...freshnessResults.flat()];

  const summary: LintSummary = {
    errors: countBySeverity(results, "error"),
    warnings: countBySeverity(results, "warning"),
    info: countBySeverity(results, "info"),
    results,
  };

  await logLintPass(root, summary);
  return summary;
}

/** Distinct page slugs touched by error/warning diagnostics, in first-seen order. */
function flaggedPageSlugs(results: LintResult[]): string[] {
  const slugs: string[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    if (result.severity === "info") continue;
    const slug = path.basename(result.file, ".md");
    if (seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
  }
  return slugs;
}

/** Journal the lint pass so log.md mirrors the gist's "lint passes" record. */
async function logLintPass(root: string, summary: LintSummary): Promise<void> {
  const heading =
    `${summary.errors} error(s), ${summary.warnings} warning(s), ${summary.info} info`;
  const flagged = flaggedPageSlugs(summary.results);
  const details = flagged.length > 0 ? [`Flagged: ${formatWikilinkList(flagged)}`] : [];
  await appendLog(root, "lint", heading, { details });
}
