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
import { loadSchema } from "../schema/index.js";
import { buildFreshnessSnapshot } from "../freshness/index.js";
import type { FreshnessSnapshot } from "../freshness/types.js";
import { loadProfile } from "../profile/load.js";
import { lintProfileEntities } from "../profile/lint.js";

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

/** Build a summary from a flat result list, computing the severity counts. */
function summarize(results: LintResult[]): LintSummary {
  return {
    errors: countBySeverity(results, "error"),
    warnings: countBySeverity(results, "warning"),
    info: countBySeverity(results, "info"),
    results,
  };
}

/**
 * Append profile-aware entity findings when the project runs a NON-default
 * profile. A default/built-in profile (`loadedFrom === null`) returns the
 * default results UNCHANGED, so the default lint output stays byte-identical.
 */
async function appendProfileFindings(root: string, defaultResults: LintResult[]): Promise<LintResult[]> {
  const { profile, loadedFrom } = await loadProfile(root);
  if (loadedFrom === null) return defaultResults;
  const profileResults = await lintProfileEntities(root, profile);
  return [...defaultResults, ...profileResults];
}

/**
 * Run all lint rules concurrently against the wiki at the given root.
 * Loads the project schema (or defaults) so schema-aware rules can enforce
 * per-kind cross-link minimums alongside structural checks. When the project
 * declares a NON-default profile, profile-aware entity findings are appended;
 * a default profile leaves the output byte-identical to the pre-profile linter.
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

  const defaultResults = [...plainResults.flat(), ...schemaResults.flat(), ...freshnessResults.flat()];
  const results = await appendProfileFindings(root, defaultResults);

  // lint is intentionally not journaled to log.md — it is a read-only check,
  // and the MCP `lint_wiki` tool documents it as non-mutating.
  return summarize(results);
}
