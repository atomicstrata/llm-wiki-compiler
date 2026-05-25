/**
 * Tests for the new formatter functions in src/eval/report.ts:
 * formatHistoryTable, formatCacheShow, formatJudgementsDisplay.
 */

import {
  formatTerminalReport,
  formatHistoryTable,
  formatCacheShow,
  formatJudgementsDisplay,
} from "../src/eval/report.js";
import type { EvalReport } from "../src/eval/types.js";
import type { CacheSummary } from "../src/eval/cache.js";
import type { CitationJudgement } from "../src/eval/types.js";

function makeReport(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    suite: "fast",
    timestamp: "2026-05-23T10:30:00.000Z",
    health: { score: 87, maxScore: 100, rules: [] },
    citationCoverage: {
      totalProseParagraphs: 20,
      citedParagraphs: 15,
      coveragePercent: 75,
      totalCitations: 15,
      validCitations: 14,
      precisionPercent: 93,
      perPage: [],
    },
    stats: {
      timestamp: "2026-05-23T10:30:00.000Z",
      sourceCount: 5,
      pageCount: 12,
      totalWikiChars: 5000,
      embeddingCount: 12,
      chunkEmbeddingCount: 80,
      avgPageLengthChars: 416,
    },
    thresholdViolations: [],
    ...overrides,
  };
}

function makeJudgement(overrides: Partial<CitationJudgement> = {}): CitationJudgement {
  return {
    claimHash: "abcd1234abcd1234",
    pageSlug: "my-page",
    citedFile: "source.md",
    lineStart: 1,
    lineEnd: 3,
    claimText: "The algorithm is efficient.",
    spanText: "It runs in O(n) time.",
    score: 2,
    reason: "Source fully supports the claim.",
    model: "claude-test",
    timestamp: "2026-05-23T10:00:00.000Z",
    ...overrides,
  };
}

describe("formatHistoryTable", () => {
  it("returns a no-history message for empty array", () => {
    const output = formatHistoryTable([]);
    expect(output).toContain("No eval history");
  });

  it("includes timestamps and health scores for each entry", () => {
    const reports = [
      makeReport({ timestamp: "2026-05-21T09:00:00.000Z", health: { score: 90, maxScore: 100, rules: [] } }),
      makeReport({ timestamp: "2026-05-23T10:30:00.000Z", health: { score: 87, maxScore: 100, rules: [] } }),
    ];
    const output = formatHistoryTable(reports);
    expect(output).toContain("90");
    expect(output).toContain("87");
    expect(output).toContain("2026-05-21");
    expect(output).toContain("2026-05-23");
  });

  it("shows — for citation support when suite is fast", () => {
    const output = formatHistoryTable([makeReport({ suite: "fast" })]);
    expect(output).toContain("—");
  });

  it("shows mean score when citation support is present", () => {
    const report = makeReport({
      suite: "full",
      citationSupport: {
        sampledCount: 10,
        totalCitations: 20,
        meanScore: 1.65,
        fullySupported: 7,
        partiallySupported: 2,
        unsupported: 1,
        judgeErrors: 0,
        judgements: [],
      },
    });
    const output = formatHistoryTable([report]);
    expect(output).toContain("1.65");
  });
});

describe("formatCacheShow", () => {
  it("shows empty message when total is zero", () => {
    const summary: CacheSummary = { total: 0, fullySupported: 0, partiallySupported: 0, unsupported: 0, byPage: [] };
    const output = formatCacheShow([], summary);
    expect(output).toContain("0 judgements");
  });

  it("shows score distribution with counts and percentages", () => {
    const judgements = [
      makeJudgement({ score: 2 }),
      makeJudgement({ score: 2, claimHash: "aaaa0001aaaa0001" }),
      makeJudgement({ score: 0, claimHash: "aaaa0002aaaa0002" }),
    ];
    const summary: CacheSummary = { total: 3, fullySupported: 2, partiallySupported: 0, unsupported: 1, byPage: [{ slug: "my-page", count: 3 }] };
    const output = formatCacheShow(judgements, summary);
    expect(output).toContain("3");
    expect(output).toContain("my-page");
  });
});

describe("formatJudgementsDisplay", () => {
  it("returns a no-judgements message for empty array", () => {
    const output = formatJudgementsDisplay([]);
    expect(output).toContain("No judgements");
  });

  it("shows page slug, file, line range, claim, span, score, and reason", () => {
    const j = makeJudgement({
      score: 0,
      reason: "Source is unrelated.",
      pageSlug: "algo-page",
      citedFile: "paper.md",
      lineStart: 5,
      lineEnd: 8,
    });
    const output = formatJudgementsDisplay([j]);
    expect(output).toContain("algo-page");
    expect(output).toContain("paper.md");
    expect(output).toContain("5");
    expect(output).toContain("8");
    expect(output).toContain("The algorithm is efficient.");
    expect(output).toContain("It runs in O(n) time.");
    expect(output).toContain("Source is unrelated.");
  });
});

describe("formatTerminalReport", () => {
  it("shows health score", () => {
    const output = formatTerminalReport(makeReport());
    expect(output).toContain("87");
    expect(output).toContain("100");
  });

  it("shows citation coverage percent", () => {
    const output = formatTerminalReport(makeReport());
    expect(output).toContain("75%");
    expect(output).toContain("15");
    expect(output).toContain("20");
  });

  it("shows threshold violations when present", () => {
    const report = makeReport({ thresholdViolations: ["health_score 87 is below threshold 90"] });
    const output = formatTerminalReport(report);
    expect(output).toContain("health_score 87 is below threshold 90");
  });

  it("omits citation support section on fast suite", () => {
    const output = formatTerminalReport(makeReport({ suite: "fast" }));
    expect(output).not.toContain("Citation Support");
  });

  it("shows citation support section on full suite", () => {
    const report = makeReport({
      suite: "full",
      citationSupport: {
        sampledCount: 10,
        totalCitations: 20,
        meanScore: 1.65,
        fullySupported: 7,
        partiallySupported: 2,
        unsupported: 1,
        judgeErrors: 0,
        judgements: [],
      },
    });
    const output = formatTerminalReport(report);
    expect(output).toContain("Citation Support");
    expect(output).toContain("1.65");
  });

  it("shows judge error count in citation support section when errors > 0", () => {
    const report = makeReport({
      suite: "full",
      citationSupport: {
        sampledCount: 9,
        totalCitations: 10,
        meanScore: 1.5,
        fullySupported: 7,
        partiallySupported: 1,
        unsupported: 1,
        judgeErrors: 1,
        judgements: [],
      },
    });
    const output = formatTerminalReport(report);
    expect(output).toContain("Judge errors:");
    expect(output).toContain("1");
  });

  it("does not render NaN when sampledCount is zero", () => {
    const report = makeReport({
      suite: "full",
      citationSupport: {
        sampledCount: 0,
        totalCitations: 5,
        meanScore: 0,
        fullySupported: 0,
        partiallySupported: 0,
        unsupported: 0,
        judgeErrors: 5,
        judgements: [],
      },
    });
    const output = formatTerminalReport(report);
    expect(output).not.toContain("NaN");
  });

  it("shows delta arrows when delta is present", () => {
    const report = makeReport({
      delta: { healthScore: 5, citationCoveragePercent: -2 },
    });
    const output = formatTerminalReport(report);
    expect(output).toContain("↑5");
    expect(output).toContain("↓2");
  });
});
