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
  /**
   * Number of pages currently awaiting review in .llmwiki/candidates/.
   * Informational only — does not affect the health score.
   */
  pendingReviews: number;
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

/** Per-source citation detail emitted by source-utilization eval. */
export interface SourceUtilizationEntry {
  sourceFile: string;
  citingPageCount: number;
  citingPages: string[];
}

export interface SourceUtilizationResult {
  totalSources: number;
  citedSources: number;
  uncitedSources: number;
  /** 0.0-1.0, or null when totalSources is 0 (not measured). */
  utilizationRate: number | null;
  /** Non-fatal issues encountered during evaluation (e.g. unreadable files). */
  warnings: string[];
  /** Sorted by citingPageCount descending. */
  perSource: SourceUtilizationEntry[];
}

/** Citation depth metrics — how precise are the wiki's citations. */
export interface CitationDepthResult {
  totalCitations: number;
  preciseCitations: number;
  vagueCitations: number;
  /** 0.0-1.0 fraction of citations that include a line range. */
  claimLevelRate: number;
  /** Average number of citation markers per prose paragraph. */
  avgCitationsPerParagraph: number;
}

export interface PageHealthEntry {
  slug: string;
  score: number;
  tier: "healthy" | "adequate" | "needs_work" | "broken";
  topIssues: string[];
}

export interface PageHealthDistributionResult {
  distribution: { healthy: number; adequate: number; needs_work: number; broken: number };
  perPage: PageHealthEntry[];
  worstPages: PageHealthEntry[];
}

export interface HubPage {
  id: string;
  indegree: number;
  outdegree: number;
  totalDegree: number;
}

export interface DanglingTarget {
  id: string;
  title: string;
  referenceCount: number;
}

export interface GraphHealthResult {
  pageCount: number;
  unreferencedCount: number;
  unreferencedPages: string[];
  componentCount: number;
  avgIndegree: number;
  hubPages: HubPage[];
  danglingCount: number;
  topDangling: DanglingTarget[];
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
  /** Ordered list of claimHash values evaluated in this run. Persisted so subsequent runs can retain the same sample as the corpus grows. */
  sampledHashes: string[];
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
  sourceUtilization: SourceUtilizationResult;
  citationDepth: CitationDepthResult;
  pageHealthDistribution?: PageHealthDistributionResult;
  graphHealth?: GraphHealthResult;
  citationSupport?: CitationSupportResult;
  stats: StatsResult;
  delta?: EvalDelta;
  thresholdViolations: string[];
}
