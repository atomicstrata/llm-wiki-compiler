/**
 * Tests for src/eval/citation-depth.ts — citation precision metrics.
 */

import { evaluateCitationDepth } from "../src/eval/citation-depth.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";

function fm(title: string, extra = ""): string {
  return "---\ntitle: " + title + "\nsources: []\nsummary: A page.\ncreatedAt: 2026-01-01\nupdatedAt: 2026-01-01" + extra + "\n---\n\n";
}

describe("evaluateCitationDepth", () => {
  const env = useLintTempRoot("eval-citdepth");

  it("returns zeroes when no pages exist", async () => {
    const result = await evaluateCitationDepth(env.dir);
    expect(result.totalCitations).toBe(0);
    expect(result.preciseCitations).toBe(0);
    expect(result.claimLevelRate).toBe(0);
    expect(result.avgCitationsPerParagraph).toBe(0);
  });

  it("counts a bare citation as vague (no line range)", async () => {
    await env.writeSource("s.md", "# S\n\nContent.");
    await env.writeConcept("p", fm("P") + "A claim without line numbers.^[s.md]\n");

    const result = await evaluateCitationDepth(env.dir);
    expect(result.totalCitations).toBe(1);
    expect(result.preciseCitations).toBe(0);
    expect(result.vagueCitations).toBe(1);
    expect(result.claimLevelRate).toBe(0);
  });

  it("counts a citation with line range as precise", async () => {
    await env.writeSource("s.md", "# S\n\nLine A.\nLine B.\n");
    await env.writeConcept("p", fm("P") + "A specific claim.^[s.md:1-2]\n");

    const result = await evaluateCitationDepth(env.dir);
    expect(result.totalCitations).toBe(1);
    expect(result.preciseCitations).toBe(1);
    expect(result.vagueCitations).toBe(0);
    expect(result.claimLevelRate).toBe(1);
  });

  it("computes correct claimLevelRate with mixed citations", async () => {
    await env.writeSource("s.md", "# S\n\nLine 1.\nLine 2.\nLine 3.\n");
    await env.writeConcept("p", fm("P") +
      "Precise claim.^[s.md:1-1]\n\n" +
      "Vague claim.^[s.md]\n\n" +
      "Another precise one.^[s.md:2-3]\n");

    const result = await evaluateCitationDepth(env.dir);
    expect(result.totalCitations).toBe(3);
    expect(result.preciseCitations).toBe(2);
    expect(result.claimLevelRate).toBeCloseTo(2 / 3, 2);
  });

  it("computes avgCitationsPerParagraph correctly", async () => {
    await env.writeSource("s.md", "# S\n\nContent.");
    await env.writeConcept("p", fm("P") +
      "Para one with two cites.^[s.md:1-1] ^[s.md:2-2]\n\n" +
      "Para two with one cite.^[s.md]\n\n" +
      "Para three with two cites.^[s.md:3-3] ^[s.md]\n");

    const result = await evaluateCitationDepth(env.dir);
    expect(result.totalCitations).toBe(5);
    expect(result.avgCitationsPerParagraph).toBeCloseTo(1.67, 1);
  });

  it("skips non-prose paragraphs (headings, code blocks)", async () => {
    await env.writeSource("s.md", "# S\n\nContent.");
    await env.writeConcept("p", fm("P") +
      "# This is a heading\n\n" +
      "```\ncode block\n```\n\n" +
      "Actual prose with cite.^[s.md]\n");

    const result = await evaluateCitationDepth(env.dir);
    expect(result.totalCitations).toBe(1);
    expect(result.avgCitationsPerParagraph).toBe(1);
  });

  it("aggregates across multiple pages", async () => {
    await env.writeSource("s.md", "# S\n\nLine 1.\nLine 2.");
    await env.writeConcept("a", fm("A") + "Vague.^[s.md]\n");
    await env.writeConcept("b", fm("B") + "Precise.^[s.md:1-2]\n");

    const result = await evaluateCitationDepth(env.dir);
    expect(result.totalCitations).toBe(2);
    expect(result.preciseCitations).toBe(1);
    expect(result.claimLevelRate).toBe(0.5);
  });
});
