/**
 * Tests for src/eval/page-health-distribution.ts.
 */

import { evaluatePageHealthDistribution } from "../src/eval/page-health-distribution.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";
import { sha256Hex, writeSourceState, writeSourceFile } from "./fixtures/state-json.js";

function fm(title: string, extra = ""): string {
  return `---
title: ${title}
sources: []
summary: A page about ${title}.
createdAt: 2026-01-01
updatedAt: 2026-01-01${extra}
---

`;
}

describe("evaluatePageHealthDistribution", () => {
  const env = useLintTempRoot("eval-phd");

  it("returns empty distribution when no pages exist", async () => {
    const result = await evaluatePageHealthDistribution(env.dir);
    expect(result.distribution.healthy).toBe(0);
    expect(result.distribution.broken).toBe(0);
    expect(result.worstPages).toHaveLength(0);
    expect(result.perPage).toHaveLength(0);
  });

  it("scores a clean page as 100", async () => {
    await env.writeConcept("clean", fm("Clean") +
      "A well-formed page with enough body text to pass all lint rules.\n");
    const result = await evaluatePageHealthDistribution(env.dir);
    expect(result.perPage[0].score).toBe(100);
    expect(result.perPage[0].tier).toBe("healthy");
  });

  it("scores a page with broken citation below 100", async () => {
    await env.writeConcept("c", fm("C") + "Text with fake citation.^[ghost.md]\n");
    const result = await evaluatePageHealthDistribution(env.dir);
    expect(result.perPage[0].score).toBeLessThan(100);
    expect(result.perPage[0].score).toBeGreaterThanOrEqual(90);
    expect(result.perPage[0].tier).toBe("healthy");
  });

  it("assigns adequate tier when score is between 70 and 89", async () => {
    await env.writeConcept("a", fm("A") +
      "C1.^[g1.md]\n\nC2.^[g2.md]\n\nC3.^[g3.md]\n");
    const result = await evaluatePageHealthDistribution(env.dir);
    expect(result.perPage[0].score).toBeLessThan(90);
    expect(result.perPage[0].score).toBeGreaterThanOrEqual(70);
    expect(result.perPage[0].tier).toBe("adequate");
  });

  it("assigns needs_work tier when score is between 50 and 69", async () => {
    const body = Array(8).fill("C.^[ghost.md]").join("\n\n");
    await env.writeConcept("n", fm("N") + body + "\n");
    const result = await evaluatePageHealthDistribution(env.dir);
    expect(result.perPage[0].score).toBeLessThan(70);
    expect(result.perPage[0].score).toBeGreaterThanOrEqual(50);
    expect(result.perPage[0].tier).toBe("needs_work");
  });

  it("assigns broken tier when score is below 50", async () => {
    const body = Array(13).fill("C.^[ghost.md]").join("\n\n");
    await env.writeConcept("b", fm("B") + body + "\n");
    const result = await evaluatePageHealthDistribution(env.dir);
    expect(result.perPage[0].score).toBeLessThan(50);
    expect(result.perPage[0].tier).toBe("broken");
  });

  it("sorts perPage worst first", async () => {
    await env.writeConcept("good", fm("Good") + "Clean page content.\n");
    await env.writeConcept("bad", fm("Bad") +
      "C1.^[g1.md]\n\nC2.^[g2.md]\n\nC3.^[g3.md]\n\nC4.^[g4.md]\n");
    const result = await evaluatePageHealthDistribution(env.dir);
    expect(result.perPage[0].slug).toBe("concepts/bad");
    expect(result.perPage[1].slug).toBe("concepts/good");
  });

  it("returns all pages in worstPages when fewer than N exist", async () => {
    await env.writeConcept("a", fm("A") + "C.^[ghost.md]\n");
    await env.writeConcept("b", fm("B") + "C.^[ghost.md]\n");
    await env.writeConcept("c", fm("C") + "Clean.\n");
    const result = await evaluatePageHealthDistribution(env.dir, 5);
    expect(result.worstPages).toHaveLength(3);
  });

  it("respects worstPageCount parameter", async () => {
    for (let i = 0; i < 8; i++) {
      await env.writeConcept("p" + i, fm("P" + i) + "C.^[ghost.md]\n");
    }
    const result = await evaluatePageHealthDistribution(env.dir, 3);
    expect(result.perPage).toHaveLength(8);
    expect(result.worstPages).toHaveLength(3);
  });

  it("includes top issues per page", async () => {
    await env.writeConcept("multi", fm("Multi") +
      "Links to [[Nowhere]].\n\nFake cite.^[ghost.md]\n");
    const result = await evaluatePageHealthDistribution(env.dir);
    expect(result.perPage[0].topIssues.length).toBeGreaterThan(0);
  });

  it("includes healthy pages in worstPages when all healthy", async () => {
    await env.writeConcept("a", fm("A") + "Clean page one.\n");
    await env.writeConcept("b", fm("B") + "Clean page two.\n");
    await env.writeConcept("c", fm("C") + "Clean page three.\n");
    const result = await evaluatePageHealthDistribution(env.dir, 2);
    expect(result.worstPages).toHaveLength(2);
    expect(result.worstPages[0].tier).toBe("healthy");
    expect(result.distribution.healthy).toBe(3);
  });
});


  
  describe("evaluateHealth with stale pages", function() {
    var env = useLintTempRoot("eval-stale");

    it("deducts points for stale pages when freshness data exists", async function() {
      await writeSourceFile(env.dir, "src.md", "original content");
      await writeSourceState(env.dir, {
        "src.md": {
          hash: sha256Hex("modified content"),
          concepts: ["stale-concept"],
        },
      });
      await env.writeConcept("stale-concept", fm("Stale Concept") +
        `This page was compiled from a source that has since been modified.^[src.md]
`);

      var evaluateHealth = (await import("../src/eval/health.js")).evaluateHealth;
      var result = await evaluateHealth(env.dir);
      var staleRule = result.rules.find(function(r) { return r.rule === "stale-page"; });
      expect(staleRule).toBeDefined();
      expect(staleRule.count).toBeGreaterThanOrEqual(1);
      expect(result.score).toBeLessThan(100);
    });
  });
describe("deductionFor handles stale pages", () => {
  it("deducts 1 point per stale-page (not classified as error)", async () => {
    // Import deductionFor directly — same function used by page-health scoring
    const { deductionFor } = await import("../src/eval/health.js");
    const result = deductionFor({
      rule: "stale-page",
      severity: "warning",
      file: "wiki/concepts/some-page.md",
      message: "Page is stale",
    });
    expect(result).toBe(1);
  });
});
