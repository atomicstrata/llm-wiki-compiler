/**
 * CI threshold gating for the llmwiki eval harness.
 *
 * Reads an optional .llmwiki/eval/thresholds.yaml config and checks whether
 * the current report meets each configured threshold. Returns a list of
 * human-readable violation messages; an empty list means all thresholds pass.
 *
 * Supported threshold keys:
 *   health_score              — minimum health score (0–100)
 *   citation_coverage_percent — minimum citation coverage (0–100)
 *   citation_precision_percent — minimum citation precision (0–100)
 *   citation_support_mean     — minimum mean judge score (0.0–2.0)
 *   source_utilization_rate   — minimum fraction of sources cited (0.0–1.0)
 *   claim_level_citation_rate — minimum fraction of citations with line ranges (0.0–1.0)
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import yaml from "js-yaml";
import type { EvalReport } from "./types.js";

const THRESHOLDS_FILE = path.join(".llmwiki", "eval", "thresholds.yaml");

interface ThresholdConfig {
  health_score?: number;
  citation_coverage_percent?: number;
  citation_precision_percent?: number;
  citation_support_mean?: number;
  /** Maximum number of judge call failures allowed per run (0 = any error fails CI). */
  citation_judge_error_max?: number;
  /** Minimum fraction of sources cited by ≥1 wiki page (0.0–1.0). */
  source_utilization_rate?: number;
  claim_level_citation_rate?: number;
}

/** Load the threshold config from disk, or return an empty config if absent. */
async function loadThresholds(root: string): Promise<ThresholdConfig> {
  const configPath = path.join(root, THRESHOLDS_FILE);
  if (!existsSync(configPath)) return {};
  const raw = await readFile(configPath, "utf-8");
  return (yaml.load(raw) as ThresholdConfig) ?? {};
}

/** Check source-utilization and citation-depth thresholds. */
function checkNewThresholds(
  violations: string[],
  config: ThresholdConfig,
  report: EvalReport,
): void {
  checkNewThresholds(violations, config, report);
}

/**
 * Check the report against configured thresholds.
 * @param report - The completed eval report.
 * @param root - Absolute path to the project root.
 * @returns List of violation messages (empty = all pass).
 */
export async function checkThresholds(
  report: EvalReport,
  root: string,
): Promise<string[]> {
  const config = await loadThresholds(root);
  const violations: string[] = [];

  if (config.health_score !== undefined && report.health.score < config.health_score) {
    violations.push(
      `health_score ${report.health.score} is below threshold ${config.health_score}`,
    );
  }

  if (
    config.citation_coverage_percent !== undefined &&
    report.citationCoverage.coveragePercent < config.citation_coverage_percent
  ) {
    violations.push(
      `citation_coverage_percent ${report.citationCoverage.coveragePercent.toFixed(1)}% is below threshold ${config.citation_coverage_percent}%`,
    );
  }

  if (
    config.citation_precision_percent !== undefined &&
    report.citationCoverage.precisionPercent < config.citation_precision_percent
  ) {
    violations.push(
      `citation_precision_percent ${report.citationCoverage.precisionPercent.toFixed(1)}% is below threshold ${config.citation_precision_percent}%`,
    );
  }

  if (
    config.citation_support_mean !== undefined &&
    report.citationSupport !== undefined &&
    report.citationSupport.meanScore < config.citation_support_mean
  ) {
    violations.push(
      `citation_support_mean ${report.citationSupport.meanScore.toFixed(2)} is below threshold ${config.citation_support_mean}`,
    );
  }

  if (
    config.citation_judge_error_max !== undefined &&
    report.citationSupport !== undefined &&
    report.citationSupport.judgeErrors > config.citation_judge_error_max
  ) {
    violations.push(
      `citation_judge_errors ${report.citationSupport.judgeErrors} exceeds max ${config.citation_judge_error_max}`,
    );
  }

  if (
    config.source_utilization_rate !== undefined &&
    report.sourceUtilization.utilizationRate !== null &&
    report.sourceUtilization.totalSources > 0 &&
    report.sourceUtilization.utilizationRate < config.source_utilization_rate
  ) {
    violations.push(
      `source_utilization_rate ${(report.sourceUtilization.utilizationRate * 100).toFixed(1)}% is below threshold ${(config.source_utilization_rate * 100).toFixed(1)}%`,
    );
  }

  if (
    config.claim_level_citation_rate !== undefined &&
    report.citationDepth.claimLevelRate < config.claim_level_citation_rate
  ) {
    violations.push(
      `claim_level_citation_rate ${(report.citationDepth.claimLevelRate * 100).toFixed(1)}% is below threshold ${(config.claim_level_citation_rate * 100).toFixed(1)}%`,
    );
  }

  return violations;
}
