/**
 * Type definitions for the llmwiki eval harness.
 *
 * Four metric families:
 *  - HealthResult: aggregated lint score (0–100)
 *  - CitationCoverageResult: prose paragraph citation rate + precision
 *  - CitationSupportResult: LLM-judged citation support quality (full suite only)
 *  - StatsResult: corpus size snapshot appended to history.jsonl
 *
 * EvalReport bundles all four plus regression deltas and CI threshold violations.
 */

export interface HealthRuleResult {
  rule: string;
  count: number;
  severity: "error" | "warning" | "info";
  deduction: number;
}

export interface HealthResult {
  score: number;
  maxScore: 100;
  rules: HealthRuleResult[];
}

export interface CitationPageResult {
  slug: string;
  proseParagraphs: number;
  citedParagraphs: number;
}

export interface CitationCoverageResult {
  totalProseParagraphs: number;
  citedParagraphs: number;
  coveragePercent: number;
  totalCitations: number;
  validCitations: number;
  precisionPercent: number;
  perPage: CitationPageResult[];
}

export interface CitationJudgement {
  /** First 16 hex chars of SHA-256(claimText + spanText) — stable cache key. */
  claimHash: string;
  pageSlug: string;
  citedFile: string;
  lineStart: number;
  lineEnd: number;
  claimText: string;
  spanText: string;
  score: 0 | 1 | 2;
  reason: string;
  model: string;
  timestamp: string;
}

export interface CitationSupportResult {
  sampledCount: number;
  totalCitations: number;
  meanScore: number;
  fullySupported: number;
  partiallySupported: number;
  unsupported: number;
  /** Number of judge calls that threw (credentials failure, network error, parse error). */
  judgeErrors: number;
  judgements: CitationJudgement[];
}

export interface StatsResult {
  timestamp: string;
  sourceCount: number;
  pageCount: number;
  totalWikiChars: number;
  embeddingCount: number;
  chunkEmbeddingCount: number;
  avgPageLengthChars: number;
}

export interface EvalDelta {
  healthScore?: number;
  citationCoveragePercent?: number;
  citationPrecisionPercent?: number;
  citationSupportMean?: number;
}

export interface EvalReport {
  suite: "fast" | "full";
  timestamp: string;
  health: HealthResult;
  citationCoverage: CitationCoverageResult;
  citationSupport?: CitationSupportResult;
  stats: StatsResult;
  delta?: EvalDelta;
  thresholdViolations: string[];
}
