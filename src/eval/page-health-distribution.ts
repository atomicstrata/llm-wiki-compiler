/**
 * Page-level health distribution evaluator for the llmwiki eval harness.
 *
 * While the corpus-level health score aggregates all lint findings into one
 * 0-100 number, this evaluator breaks it down per page so maintainers can
 * see *which* pages need attention — not just that *something* is wrong.
 *
 * Scoring reuses deductionFor() from health.ts so per-page scores are
 * consistent with the overall health score. Lint rules are sourced from
 * the canonical linter orchestrator (lint()) via runAllLintRules() so
 * all rules including freshness checks are included automatically.
 */

import path from "path";
import { collectAllPages } from "../linter/rules.js";
import { runAllLintRules, deductionFor } from "./health.js";
import type { LintResult } from "../linter/types.js";
import type { PageHealthDistributionResult, PageHealthEntry } from "./types.js";

const MAX_SCORE = 100;
const TIER_HEALTHY = 90;
const TIER_ADEQUATE = 70;
const TIER_NEEDS_WORK = 50;

function tierFor(score: number): PageHealthEntry["tier"] {
  if (score >= TIER_HEALTHY) return "healthy";
  if (score >= TIER_ADEQUATE) return "adequate";
  if (score >= TIER_NEEDS_WORK) return "needs_work";
  return "broken";
}

function topIssues(findings: LintResult[]): string[] {
  const counts = new Map<string, number>();
  for (const f of findings) {
    counts.set(f.rule, (counts.get(f.rule) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([rule, count]) => count > 1 ? rule + " x" + count : rule);
}

/**
 * Evaluate per-page health across all wiki pages.
 * Delegates to the canonical linter orchestrator for rule execution
 * and reuses the same deductionFor() so scores match evaluateHealth.
 * @param root - Absolute path to the project root.
 * @param worstPageCount - How many worst pages to return (default 5).
 */
export async function evaluatePageHealthDistribution(
  root: string,
  worstPageCount = 5,
): Promise<PageHealthDistributionResult> {
  const [allResults, pages] = await Promise.all([
    runAllLintRules(root),
    collectAllPages(root),
  ]);

  const findingsByPath = new Map<string, LintResult[]>();
  for (const r of allResults) {
    const existing = findingsByPath.get(r.file);
    if (existing) existing.push(r);
    else findingsByPath.set(r.file, [r]);
  }

  for (const { filePath } of pages) {
    if (!findingsByPath.has(filePath)) {
      findingsByPath.set(filePath, []);
    }
  }

  const perPage: PageHealthEntry[] = [];
  for (const [filePath, findings] of findingsByPath) {
    const slug = path.basename(path.dirname(filePath)) + "/" + path.basename(filePath, ".md");
    const totalDeduction = findings.reduce((sum, r) => sum + deductionFor(r), 0);
    const score = Math.max(0, MAX_SCORE - totalDeduction);
    perPage.push({ slug, score, tier: tierFor(score), topIssues: topIssues(findings) });
  }

  perPage.sort((a, b) => a.score - b.score || a.slug.localeCompare(b.slug));

  const distribution = {
    healthy: perPage.filter((p) => p.tier === "healthy").length,
    adequate: perPage.filter((p) => p.tier === "adequate").length,
    needs_work: perPage.filter((p) => p.tier === "needs_work").length,
    broken: perPage.filter((p) => p.tier === "broken").length,
  };

  return { distribution, perPage, worstPages: perPage.slice(0, worstPageCount) };
}
