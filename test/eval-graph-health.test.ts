/**
 * Tests for src/eval/graph-health.ts.
 */

import { evaluateGraphHealth } from "../src/eval/graph-health.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";

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

describe("evaluateGraphHealth", () => {
  const env = useLintTempRoot("eval-gh");

  it("returns null when no pages exist", async () => {
    const result = await evaluateGraphHealth(env.dir);
    expect(result).toBeNull();
  });

  it("counts a single isolated page as unreferenced", async () => {
    await env.writeConcept("lonely", fm("Lonely") + "No links.\n");
    const result = await evaluateGraphHealth(env.dir);
    expect(result).not.toBeNull();
    expect(result!.pageCount).toBe(1);
    expect(result!.unreferencedCount).toBe(1);
    expect(result!.unreferencedPages).toContain("concepts/lonely");
    expect(result!.componentCount).toBe(1);
    expect(result!.avgIndegree).toBe(0);
    expect(result!.danglingCount).toBe(0);
  });

  it("detects a bidirectional link correctly", async () => {
    await env.writeConcept("a", fm("A") + "Links to B. [[B]]\n");
    await env.writeConcept("b", fm("B") + "Links to A. [[A]]\n");
    const result = await evaluateGraphHealth(env.dir);
    expect(result!.pageCount).toBe(2);
    expect(result!.unreferencedCount).toBe(0);
    expect(result!.componentCount).toBe(1);
    expect(result!.avgIndegree).toBe(1);
  });

  it("identifies hub pages by total degree", async () => {
    await env.writeConcept("hub", fm("Hub") + "\n");
    await env.writeConcept("a", fm("A") + "Links to hub. [[Hub]]\n");
    await env.writeConcept("b", fm("B") + "Links to hub. [[Hub]]\n");
    const result = await evaluateGraphHealth(env.dir);
    // hub has indegree=2, outdegree=0 → totalDegree=2
    expect(result!.hubPages.length).toBeGreaterThan(0);
    expect(result!.hubPages[0].id).toBe("concepts/hub");
    expect(result!.hubPages[0].indegree).toBe(2);
    expect(result!.hubPages[0].outdegree).toBe(0);
    expect(result!.hubPages[0].totalDegree).toBe(2);
  });

  it("counts multiple connected components", async () => {
    await env.writeConcept("a", fm("A") + "[[B]]\n");
    await env.writeConcept("b", fm("B") + "[[A]]\n");
    await env.writeConcept("c", fm("C") + "[[D]]\n");
    await env.writeConcept("d", fm("D") + "[[C]]\n");
    const result = await evaluateGraphHealth(env.dir);
    expect(result!.pageCount).toBe(4);
    expect(result!.componentCount).toBe(2);
  });

  it("counts dangling wikilink targets", async () => {
    await env.writeConcept("real", fm("Real") + "Links to [[Ghost]].\n");
    const result = await evaluateGraphHealth(env.dir);
    expect(result!.danglingCount).toBeGreaterThanOrEqual(1);
    expect(result!.topDangling.length).toBeGreaterThan(0);
    expect(result!.topDangling[0].title).toBe("Ghost");
    expect(result!.topDangling[0].id).toBeDefined();
  });

  it("does not count dangling links in avgIndegree", async () => {
    // A → B(ghost). avgIndegree should be 0 because ghost links don't count.
    await env.writeConcept("a", fm("A") + "Links to [[Ghost]].\n");
    const result = await evaluateGraphHealth(env.dir);
    expect(result!.avgIndegree).toBe(0);
  });

  it("ties-break hub pages by slug", async () => {
    await env.writeConcept("alpha", fm("Alpha") + "[[Gamma]]\n");
    await env.writeConcept("beta", fm("Beta") + "[[Gamma]]\n");
    await env.writeConcept("gamma", fm("Gamma") + "\n");
    const result = await evaluateGraphHealth(env.dir);
    // gamma has indegree 2. alpha and beta have indegree 0, outdegree 1.
    // Tie-break between alpha and beta → slug order (alpha < beta)
    const ids = result!.hubPages.map((h) => h.id);
    const alphaIdx = ids.indexOf("concepts/alpha");
    const betaIdx = ids.indexOf("concepts/beta");
    expect(alphaIdx).toBeGreaterThanOrEqual(0);
    expect(betaIdx).toBeGreaterThanOrEqual(0);
    expect(alphaIdx).toBeLessThan(betaIdx);
  });
});
