/**
 * Shared factory for EvalReport test fixtures used across eval test files.
 */

import type { EvalReport } from "../../src/eval/types.js";

export function makeEvalReport(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    suite: "fast",
    timestamp: new Date().toISOString(),
    health: { score: 90, maxScore: 100, rules: [] },
    citationCoverage: {
      totalProseParagraphs: 10,
      citedParagraphs: 8,
      coveragePercent: 80,
      totalCitations: 8,
      validCitations: 8,
      precisionPercent: 100,
      perPage: [],
    },
    stats: {
      timestamp: new Date().toISOString(),
      sourceCount: 3,
      pageCount: 5,
      totalWikiChars: 1000,
      embeddingCount: 5,
      chunkEmbeddingCount: 20,
      avgPageLengthChars: 200,
    },
    thresholdViolations: [],
    ...overrides,
  };
}
