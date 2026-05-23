/**
 * Tests for src/eval/thresholds.ts — CI threshold gating.
 * Verifies each threshold key, the fast-suite edge case, and accumulation.
 */

import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { checkThresholds } from "../src/eval/thresholds.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";
import { makeEvalReport as makeReport } from "./fixtures/eval-report.js";

async function writeThresholds(root: string, config: object): Promise<void> {
  const dir = path.join(root, ".llmwiki", "eval");
  await mkdir(dir, { recursive: true });
  const lines = Object.entries(config)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  await writeFile(path.join(dir, "thresholds.yaml"), lines + "\n");
}

describe("checkThresholds", () => {
  const env = useLintTempRoot("eval-thresholds");

  it("returns empty array when no thresholds file exists", async () => {
    const violations = await checkThresholds(makeReport(), env.dir);
    expect(violations).toHaveLength(0);
  });

  it("returns empty array when all thresholds are met", async () => {
    await writeThresholds(env.dir, {
      health_score: 85,
      citation_coverage_percent: 70,
      citation_precision_percent: 90,
    });

    const violations = await checkThresholds(makeReport(), env.dir);
    expect(violations).toHaveLength(0);
  });

  it("flags health_score below threshold", async () => {
    await writeThresholds(env.dir, { health_score: 95 });

    const violations = await checkThresholds(makeReport(), env.dir);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("health_score");
    expect(violations[0]).toContain("90");
    expect(violations[0]).toContain("95");
  });

  it("flags citation_coverage_percent below threshold", async () => {
    await writeThresholds(env.dir, { citation_coverage_percent: 90 });

    const violations = await checkThresholds(makeReport(), env.dir);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("citation_coverage_percent");
  });

  it("flags citation_precision_percent below threshold", async () => {
    await writeThresholds(env.dir, { citation_precision_percent: 100 });

    const report = makeReport({
      citationCoverage: {
        totalProseParagraphs: 10,
        citedParagraphs: 8,
        coveragePercent: 80,
        totalCitations: 8,
        validCitations: 7,
        precisionPercent: 87.5,
        perPage: [],
      },
    });

    const violations = await checkThresholds(report, env.dir);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("citation_precision_percent");
  });

  it("flags citation_support_mean below threshold when support data is present", async () => {
    await writeThresholds(env.dir, { citation_support_mean: 1.5 });

    const report = makeReport({
      citationSupport: {
        sampledCount: 10,
        totalCitations: 20,
        meanScore: 1.2,
        fullySupported: 5,
        partiallySupported: 3,
        unsupported: 2,
        judgements: [],
      },
    });

    const violations = await checkThresholds(report, env.dir);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("citation_support_mean");
    expect(violations[0]).toContain("1.5");
  });

  it("does NOT flag citation_support_mean when report has no citation support (fast suite)", async () => {
    await writeThresholds(env.dir, { citation_support_mean: 1.5 });

    const violations = await checkThresholds(makeReport(), env.dir);
    expect(violations).toHaveLength(0);
  });

  it("accumulates multiple violations into the returned array", async () => {
    await writeThresholds(env.dir, {
      health_score: 95,
      citation_coverage_percent: 90,
    });

    const violations = await checkThresholds(makeReport(), env.dir);
    expect(violations).toHaveLength(2);
    expect(violations.some((v) => v.includes("health_score"))).toBe(true);
    expect(violations.some((v) => v.includes("citation_coverage_percent"))).toBe(true);
  });
});
