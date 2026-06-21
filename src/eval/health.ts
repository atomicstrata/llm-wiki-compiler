/**
 * Health score evaluator for the llmwiki eval harness.
 *
 * Aggregates the output of all 10+ lint rules into a single 0–100 score.
 * Errors on critical rules (broken links/citations, duplicates) cost 4 pts
 * each; contradicted pages cost 2 pts; all other warnings/info cost 1 pt each.
 * The final score is clamped to [0, 100].
 */

import {
  checkBrokenWikilinks,
  checkBrokenCitations,
  checkMalformedClaimCitations,
  checkOrphanedPages,
  checkMissingSummaries,
  checkDuplicateConcepts,
  checkEmptyPages,
  checkLowConfidencePages,
  checkContradictedPages,
  checkInferredWithoutCitations,
  checkSchemaCrossLinks,
} from "../linter/rules.js";
import { loadSchema } from "../schema/loader.js";
import { countCandidates } from "../compiler/candidates.js";
import { lint } from "../linter/index.js";
import type { LintResult } from "../linter/types.js";
import type { HealthResult, HealthRuleResult } from "./types.js";

const MAX_SCORE = 100;
const ERROR_DEDUCTION = 4;
const CONTRADICTED_DEDUCTION = 2;
const DEFAULT_DEDUCTION = 1;

/** Rules treated as high-severity errors (−4 pts per violation). */
const ERROR_RULES = new Set([
  "broken-wikilink",
  "broken-citation",
  "duplicate-concept",
]);

/** Compute the point deduction for a single lint result. */
export function deductionFor(result: LintResult): number {
  if (result.rule === "pending-target") return 0;
  if (ERROR_RULES.has(result.rule)) return ERROR_DEDUCTION;
  if (result.rule === "contradicted-page") return CONTRADICTED_DEDUCTION;
  return DEFAULT_DEDUCTION;
}

/** Aggregate lint results into a per-rule summary with deduction totals. */
function aggregateRules(results: LintResult[]): HealthRuleResult[] {
  const map = new Map<string, HealthRuleResult>();
  for (const result of results) {
    const existing = map.get(result.rule);
    const deduction = deductionFor(result);
    if (existing) {
      existing.count++;
      existing.deduction += deduction;
    } else {
      map.set(result.rule, {
        rule: result.rule,
        count: 1,
        severity: result.severity,
        deduction,
      });
    }
  }
  return Array.from(map.values());
}

/**
 * Run all lint rules against the project root and return an aggregated
 * health score plus per-rule breakdown.
 * @param root - Absolute path to the project root.
 */
/**
 * Run all lint rules via the canonical linter orchestrator and return
 * flat results. Delegates to lint() so the rule list stays in sync with
 * llmwiki lint — no manual list to maintain. Used by evaluateHealth and
 * by page-health-distribution so both see the same diagnostics.
 */
export async function runAllLintRules(root: string): Promise<LintResult[]> {
  const summary = await lint(root);
  return summary.results;
}

export async function evaluateHealth(root: string): Promise<HealthResult> {
  const [allResults, pendingReviews] = await Promise.all([
    runAllLintRules(root),
    countCandidates(root).catch(() => 0),
  ]);

  const rules = aggregateRules(allResults);
  const totalDeduction = rules.reduce((sum, r) => sum + r.deduction, 0);
  const score = Math.max(0, MAX_SCORE - totalDeduction);

  return { score, maxScore: MAX_SCORE, rules, pendingReviews };
}
