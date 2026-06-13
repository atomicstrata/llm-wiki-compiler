/**
 * Tests for src/eval/health.ts — lint-score aggregation.
 * Verifies weight map, per-rule deductions, and clamping.
 */

import { evaluateHealth } from "../src/eval/health.js";
import { writeCandidate } from "../src/compiler/candidates.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";

describe("evaluateHealth", () => {
  const env = useLintTempRoot("eval-health");

  it("scores 100 for a clean wiki with no pages", async () => {
    const result = await evaluateHealth(env.dir);
    expect(result.score).toBe(100);
    expect(result.maxScore).toBe(100);
    expect(result.rules.every((r) => r.count === 0)).toBe(true);
  });

  it("deducts 4 points per broken-citation (error rule)", async () => {
    // Page body cites a non-existent source → broken-citation
    await env.writeConcept(
      "alpha",
      `---\ntitle: Alpha\nsources: []\nsummary: A concept.\ncreatedAt: 2024-01-01\nupdatedAt: 2024-01-01\n---\n\nThis is a substantive claim about the topic with enough text to pass empty-page checks.^[missing-source.md]\n`,
    );

    const result = await evaluateHealth(env.dir);
    const brokenCitationRule = result.rules.find(
      (r) => r.rule === "broken-citation",
    );
    expect(brokenCitationRule?.count).toBe(1);
    expect(brokenCitationRule?.deduction).toBe(4);
    expect(result.score).toBe(96);
  });

  it("deducts 2 points per contradicted-page", async () => {
    await env.writeConcept(
      "beta",
      `---\ntitle: Beta\nsources: []\nsummary: A concept.\ncontradictedBy:\n  - slug: other\ncreatedAt: 2024-01-01\nupdatedAt: 2024-01-01\n---\n\nThis page has enough body content to avoid the empty-page rule threshold check.\n`,
    );

    const result = await evaluateHealth(env.dir);
    const contradictedRule = result.rules.find(
      (r) => r.rule === "contradicted-page",
    );
    expect(contradictedRule?.count).toBe(1);
    expect(contradictedRule?.deduction).toBe(2);
    expect(result.score).toBe(98);
  });

  it("deducts 1 point per warning (orphaned page)", async () => {
    await env.writeConcept(
      "gamma",
      `---\ntitle: Gamma\nsources: []\nsummary: A concept.\norphaned: true\ncreatedAt: 2024-01-01\nupdatedAt: 2024-01-01\n---\n\nThis page has enough body content to avoid the empty-page rule threshold.\n`,
    );

    const result = await evaluateHealth(env.dir);
    const orphanedRule = result.rules.find((r) => r.rule === "orphaned-page");
    expect(orphanedRule?.count).toBe(1);
    expect(orphanedRule?.deduction).toBe(1);
    expect(result.score).toBe(99);
  });

  it("deducts 4 points per broken-wikilink (error rule)", async () => {
    await env.writeConcept(
      "linker",
      `---\ntitle: Linker\nsources: []\nsummary: A concept.\ncreatedAt: 2024-01-01\nupdatedAt: 2024-01-01\n---\n\nThis page references [[Nonexistent Page]] which does not exist.\n`,
    );

    const result = await evaluateHealth(env.dir);
    const wikilinkRule = result.rules.find((r) => r.rule === "broken-wikilink");
    expect(wikilinkRule?.count).toBe(1);
    expect(wikilinkRule?.deduction).toBe(4);
    expect(result.score).toBe(96);
  });

  it("clamps score to 0 with many violations", async () => {
    // Create 30 broken citation pages → 30 × -4 = -120, clamps to 0
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        env.writeConcept(
          `page-${i}`,
          `---\ntitle: Page ${i}\nsources: []\nsummary: A concept.\ncreatedAt: 2024-01-01\nupdatedAt: 2024-01-01\n---\n\nSome claim.^[ghost.md]\n`,
        ),
      ),
    );

    const result = await evaluateHealth(env.dir);
    expect(result.score).toBe(0);
  });

  it("surfaces pending-review count without penalising health score", async () => {
    await writeCandidate(env.dir, {
      title: "Pending Concept",
      slug: "pending-concept",
      summary: "Pending.",
      sources: [],
      body: "pending body",
      reviewMode: "policy",
      heldReasons: [{ code: "low-confidence" }],
    });

    const result = await evaluateHealth(env.dir);
    expect(result.pendingReviews).toBe(1);
    expect(result.score).toBe(100);
  });
});
