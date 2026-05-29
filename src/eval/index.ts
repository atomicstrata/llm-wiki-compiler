/**
 * Report assembly for the llmwiki eval harness.
 *
 * Combines evaluated components (health, citation coverage, stats, citation support)
 * into a final EvalReport with delta tracking and threshold validation.
 * Shared by the CLI eval command and the MCP run_eval tool.
 */

import { evaluateHealth } from "./health.js";
import { evaluateCitationCoverage } from "./citation-coverage.js";
import { evaluateCitationSupport } from "./citation-support.js";
import { collectStats, appendHistory, loadPreviousReport, loadLastFullReport } from "./stats.js";
import { computeDelta } from "./delta.js";
import { checkThresholds } from "./thresholds.js";
import type { EvalReport, HealthResult, CitationCoverageResult, CitationSupportResult, StatsResult } from "./types.js";

interface EvalComponents {
  health: HealthResult;
  citationCoverage: CitationCoverageResult;
  stats: StatsResult;
  previousReport: EvalReport | null;
  citationSupport?: CitationSupportResult | null;
}

async function buildReport(root: string, components: EvalComponents, suite: "fast" | "full"): Promise<EvalReport> {
  const { health, citationCoverage, stats, previousReport, citationSupport } = components;
  const partial = {
    suite,
    timestamp: new Date().toISOString(),
    health,
    citationCoverage,
    stats,
    ...(citationSupport ? { citationSupport } : {}),
  };
  const delta = previousReport ? computeDelta(partial as EvalReport, previousReport) : undefined;
  const thresholdViolations = await checkThresholds(partial as EvalReport, root);
  return { ...partial, ...(delta ? { delta } : {}), thresholdViolations };
}

/** Run the full eval pipeline, optionally append to history, and return the report. */
export async function runEval(root: string, suite: "fast" | "full", sampleSize: number, record = true): Promise<EvalReport> {
  const [health, citationCoverage, stats, previousReport, previousFullReport] = await Promise.all([
    evaluateHealth(root),
    evaluateCitationCoverage(root),
    collectStats(root),
    loadPreviousReport(root),
    suite === "full" ? loadLastFullReport(root) : Promise.resolve(null),
  ]);
  const citationSupport = suite === "full"
    ? await evaluateCitationSupport(root, sampleSize, previousFullReport?.citationSupport?.sampledHashes ?? [])
    : undefined;
  const report = await buildReport(root, { health, citationCoverage, stats, previousReport, citationSupport }, suite);
  if (record) await appendHistory(root, report);
  return report;
}
