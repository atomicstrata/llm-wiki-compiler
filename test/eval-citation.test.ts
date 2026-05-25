/**
 * Tests for src/eval/citation-coverage.ts — prose paragraph citation rate.
 * Verifies coverage%, precision%, and per-page breakdown.
 */

import { evaluateCitationCoverage } from "../src/eval/citation-coverage.js";
import type { CitationCoverageResult } from "../src/eval/types.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";

function expectTwoValidCitations(result: CitationCoverageResult): void {
  expect(result.totalCitations).toBe(2);
  expect(result.validCitations).toBe(2);
  expect(result.precisionPercent).toBe(100);
}

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

  it("counts each source file in a multi-source marker as a separate citation", async () => {
    await env.writeSource("a.md", "Source A.");
    await env.writeSource("b.md", "Source B.");
    await env.writeConcept(
      "multi-source",
      `---\ntitle: Multi\nsources: [a.md, b.md]\nsummary: A concept.\ncreatedAt: 2024-01-01\nupdatedAt: 2024-01-01\n---\n\nClaim citing two sources.^[a.md, b.md]\n`,
    );

    expectTwoValidCitations(await evaluateCitationCoverage(env.dir));
  });

  it("counts each individually listed line in a comma-separated line list as a separate citation span", async () => {
    await env.writeSource("ref.md", "Line one.\nLine two.\nLine three.\nLine four.\nLine five.\nLine six.\nLine seven.\nLine eight.\nLine nine.\nLine ten.\nLine eleven.\nLine twelve.\n");
    await env.writeConcept(
      "comma-lines",
      `---\ntitle: Comma Lines\nsources: [ref.md]\nsummary: A concept.\ncreatedAt: 2024-01-01\nupdatedAt: 2024-01-01\n---\n\nClaim citing two individual lines from one source.^[ref.md:1, 12]\n`,
    );

    expectTwoValidCitations(await evaluateCitationCoverage(env.dir));
  });

  it("counts all spans in a multi-source span marker correctly", async () => {
    await env.writeSource("a.md", "A\nB\nC\nD\nE\n");
    await env.writeSource("b.md", "A\nB\nC\nD\nE\nF\nG\nH\nI\nJ\nK\nL\n");
    await env.writeConcept(
      "multi-span",
      `---\ntitle: Multi Span\nsources: [a.md, b.md]\nsummary: A concept.\ncreatedAt: 2024-01-01\nupdatedAt: 2024-01-01\n---\n\nClaim citing span ranges from two sources.^[a.md:1-5, b.md:10-12]\n`,
    );

    expectTwoValidCitations(await evaluateCitationCoverage(env.dir));
  });
});
