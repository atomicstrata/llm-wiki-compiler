/**
 * Tests for src/eval/delta.ts — regression detection between eval runs.
 */

import { computeDelta } from "../src/eval/delta.js";
import type { EvalReport } from "../src/eval/types.js";

function makeReport(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    suite: "fast",
    timestamp: new Date().toISOString(),
    health: { score: 80, maxScore: 100, rules: [] },
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
      sourceCount: 5,
      pageCount: 10,
      totalWikiChars: 2000,
      embeddingCount: 10,
      chunkEmbeddingCount: 40,
      avgPageLengthChars: 200,
    },
    thresholdViolations: [],
    ...overrides,
  };
}

describe("computeDelta", () => {
  it("returns positive delta when health score improves", () => {
    const previous = makeReport();
    const current = makeReport({ health: { score: 90, maxScore: 100, rules: [] } });

    const delta = computeDelta(current, previous);
    expect(delta.healthScore).toBe(10);
  });

  it("returns negative delta when health score drops", () => {
    const previous = makeReport({ health: { score: 90, maxScore: 100, rules: [] } });
    const current = makeReport();

    const delta = computeDelta(current, previous);
    expect(delta.healthScore).toBe(-10);
  });

  it("returns delta for citation coverage", () => {
    const previous = makeReport();
    const current = makeReport({
      citationCoverage: {
        totalProseParagraphs: 10,
        citedParagraphs: 10,
        coveragePercent: 100,
        totalCitations: 10,
        validCitations: 9,
        precisionPercent: 90,
        perPage: [],
      },
    });

    const delta = computeDelta(current, previous);
    expect(delta.citationCoveragePercent).toBe(20);
    expect(delta.citationPrecisionPercent).toBe(-10);
  });

  it("omits citationSupportMean when neither report has citation support", () => {
    const delta = computeDelta(makeReport(), makeReport());
    expect(delta.citationSupportMean).toBeUndefined();
  });

  it("includes citationSupportMean when both reports have citation support", () => {
    const previous = makeReport({
      citationSupport: {
        sampledCount: 10,
        totalCitations: 20,
        meanScore: 1.5,
        fullySupported: 7,
        partiallySupported: 2,
        unsupported: 1,
        judgements: [],
      },
    });
    const current = makeReport({
      citationSupport: {
        sampledCount: 10,
        totalCitations: 20,
        meanScore: 1.8,
        fullySupported: 9,
        partiallySupported: 1,
        unsupported: 0,
        judgements: [],
      },
    });

    const delta = computeDelta(current, previous);
    expect(delta.citationSupportMean).toBeCloseTo(0.3);
  });
});
