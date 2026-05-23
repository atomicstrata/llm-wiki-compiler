/**
 * Regression detection for the llmwiki eval harness.
 *
 * Computes signed metric deltas between the current eval report and the
 * previous one from history.jsonl. Positive = improvement, negative = regression.
 * Fields are omitted when either report lacks the data (e.g. citationSupportMean
 * is only present on full-suite runs).
 */

import type { EvalReport, EvalDelta } from "./types.js";

/**
 * Compute the signed difference between current and previous eval metrics.
 * @param current - The just-completed report.
 * @param previous - The last report loaded from history.jsonl.
 */
export function computeDelta(current: EvalReport, previous: EvalReport): EvalDelta {
  const delta: EvalDelta = {
    healthScore: current.health.score - previous.health.score,
    citationCoveragePercent:
      current.citationCoverage.coveragePercent - previous.citationCoverage.coveragePercent,
    citationPrecisionPercent:
      current.citationCoverage.precisionPercent - previous.citationCoverage.precisionPercent,
  };

  if (current.citationSupport !== undefined && previous.citationSupport !== undefined) {
    delta.citationSupportMean =
      current.citationSupport.meanScore - previous.citationSupport.meanScore;
  }

  return delta;
}
