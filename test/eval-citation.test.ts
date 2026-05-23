/**
 * Tests for src/eval/citation-coverage.ts — prose paragraph citation rate.
 * Verifies coverage%, precision%, and per-page breakdown.
 */

import { evaluateCitationCoverage } from "../src/eval/citation-coverage.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";

describe("evaluateCitationCoverage", () => {
  const env = useLintTempRoot("eval-citation");

  it("returns zeros for a wiki with no pages", async () => {
    const result = await evaluateCitationCoverage(env.dir);
    expect(result.totalProseParagraphs).toBe(0);
    expect(result.citedParagraphs).toBe(0);
    expect(result.coveragePercent).toBe(0);
    expect(result.totalCitations).toBe(0);
  });

  it("counts 100% coverage when all prose paragraphs have citations", async () => {
    await env.writeSource("ref.md", "Some source content.");
    await env.writeConcept(
      "fully-cited",
      `---\ntitle: Fully Cited\nsources: [ref.md]\nsummary: A concept.\ncreatedAt: 2024-01-01\nupdatedAt: 2024-01-01\n---\n\nFirst claim with a citation.^[ref.md]\n\nSecond claim also cited.^[ref.md]\n`,
    );

    const result = await evaluateCitationCoverage(env.dir);
    expect(result.totalProseParagraphs).toBe(2);
    expect(result.citedParagraphs).toBe(2);
    expect(result.coveragePercent).toBe(100);
  });

  it("counts 0% coverage when no prose paragraphs have citations", async () => {
    await env.writeConcept(
      "uncited",
      `---\ntitle: Uncited\nsources: []\nsummary: A concept.\ncreatedAt: 2024-01-01\nupdatedAt: 2024-01-01\n---\n\nFirst claim without any citation whatsoever.\n\nSecond claim also without a citation marker.\n`,
    );

    const result = await evaluateCitationCoverage(env.dir);
    expect(result.totalProseParagraphs).toBe(2);
    expect(result.citedParagraphs).toBe(0);
    expect(result.coveragePercent).toBe(0);
  });

  it("counts 50% coverage for mixed pages", async () => {
    await env.writeSource("ref.md", "Some source content.");
    await env.writeConcept(
      "mixed",
      `---\ntitle: Mixed\nsources: [ref.md]\nsummary: A concept.\ncreatedAt: 2024-01-01\nupdatedAt: 2024-01-01\n---\n\nCited paragraph.^[ref.md]\n\nUncited paragraph without any reference at all.\n`,
    );

    const result = await evaluateCitationCoverage(env.dir);
    expect(result.totalProseParagraphs).toBe(2);
    expect(result.citedParagraphs).toBe(1);
    expect(result.coveragePercent).toBe(50);
  });

  it("counts 100% citation precision when all cited sources exist", async () => {
    await env.writeSource("real.md", "Real source content.");
    await env.writeConcept(
      "precise",
      `---\ntitle: Precise\nsources: [real.md]\nsummary: A concept.\ncreatedAt: 2024-01-01\nupdatedAt: 2024-01-01\n---\n\nClaim backed by real source.^[real.md]\n`,
    );

    const result = await evaluateCitationCoverage(env.dir);
    expect(result.totalCitations).toBe(1);
    expect(result.validCitations).toBe(1);
    expect(result.precisionPercent).toBe(100);
  });

  it("counts 0% precision when cited source file does not exist", async () => {
    await env.writeConcept(
      "imprecise",
      `---\ntitle: Imprecise\nsources: []\nsummary: A concept.\ncreatedAt: 2024-01-01\nupdatedAt: 2024-01-01\n---\n\nClaim backed by nonexistent source.^[ghost.md]\n`,
    );

    const result = await evaluateCitationCoverage(env.dir);
    expect(result.totalCitations).toBe(1);
    expect(result.validCitations).toBe(0);
    expect(result.precisionPercent).toBe(0);
  });
});
