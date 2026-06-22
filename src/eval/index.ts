/**
 * Report assembly for the llmwiki eval harness.
 *
 * Combines evaluated components (health, citation coverage, stats, citation support)
 * into a final EvalReport with delta tracking and threshold validation.
 * Shared by the CLI eval command and the MCP run_eval tool.
 */

import { evaluateHealth } from "./health.js";
import { evaluateCitationCoverage } from "./citation-coverage.js";
import { evaluateSourceUtilization } from "./source-utilization.js";
import { evaluateCitationDepth } from "./citation-depth.js";
import { evaluatePageHealthDistribution } from "./page-health-distribution.js";
import { evaluateGraphHealth } from "./graph-health.js";
import { evaluateCitationSupport } from "./citation-support.js";
import { collectStats, appendHistory, loadPreviousReport, loadLastFullReport } from "./stats.js";
import { computeDelta } from "./delta.js";
import { checkThresholds } from "./thresholds.js";
import { ensureProviderAvailable } from "../utils/provider-guard.js";
import type { EvalReport, HealthResult, CitationCoverageResult, SourceUtilizationResult, CitationDepthResult, PageHealthDistributionResult, GraphHealthResult, CitationSupportResult, StatsResult } from "./types.js";

export const DEFAULT_SAMPLE_SIZE = 20;

interface EvalComponents {
  health: HealthResult;
  citationCoverage: CitationCoverageResult;
  sourceUtilization: SourceUtilizationResult;
  citationDepth: CitationDepthResult;
  pageHealthDistribution?: PageHealthDistributionResult;
  graphHealth?: GraphHealthResult | null;
  stats: StatsResult;
  previousReport: EvalReport | null;
  citationSupport?: CitationSupportResult | null;
}

async function buildReport(root: string, components: EvalComponents, suite: "fast" | "full"): Promise<EvalReport> {
  const { health, citationCoverage, sourceUtilization, citationDepth, pageHealthDistribution, graphHealth, stats, previousReport, citationSupport } = components;
  const partial = {
    suite,
    timestamp: new Date().toISOString(),
    health,
    citationCoverage,
    sourceUtilization,
    citationDepth,
    ...(pageHealthDistribution ? { pageHealthDistribution } : {}),
    ...(graphHealth ? { graphHealth } : {}),
    stats,
    ...(citationSupport ? { citationSupport } : {}),
  };
  const delta = previousReport ? computeDelta(partial as EvalReport, previousReport) : undefined;
  const thresholdViolations = await checkThresholds(partial as EvalReport, root);
  return { ...partial, ...(delta ? { delta } : {}), thresholdViolations };
}

/** Run the full eval pipeline, optionally append to history, and return the report. */
export async function runEval(root: string, suite: "fast" | "full", sampleSize: number, record = true): Promise<EvalReport> {
  if (suite === "full") ensureProviderAvailable();
  const [health, citationCoverage, sourceUtilization, citationDepth, pageHealthDistribution, graphHealth, stats, previousReport, previousFullReport] = await Promise.all([
    evaluateHealth(root),
    evaluateCitationCoverage(root),
    evaluateSourceUtilization(root),
    evaluateCitationDepth(root),
    evaluatePageHealthDistribution(root),
    evaluateGraphHealth(root),
    collectStats(root),
    loadPreviousReport(root),
    suite === "full" ? loadLastFullReport(root) : Promise.resolve(null),
  ]);
  const citationSupport = suite === "full"
    ? await evaluateCitationSupport(root, sampleSize, previousFullReport?.citationSupport?.sampledHashes ?? [])
    : undefined;
  const report = await buildReport(root, { health, citationCoverage, sourceUtilization, citationDepth, pageHealthDistribution, graphHealth, stats, previousReport, citationSupport }, suite);
  if (record) await appendHistory(root, report);
  return report;
}
