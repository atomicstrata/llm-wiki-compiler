/**
 * Tests for src/eval/source-utilization.ts — source utilization metrics.
 * Verifies utilizationRate, uncitedSources, perSource detail, and
 * citation collection across concept and query pages.
 */

import { evaluateSourceUtilization } from "../src/eval/source-utilization.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";

/** Frontmatter boilerplate shared by most test pages. */
function fm(title: string, extra = ""): string {
  return `---\ntitle: ${title}\nsources: []\nsummary: A page about ${title}.\ncreatedAt: 2026-01-01\nupdatedAt: 2026-01-01${extra}\n---\n\n`;
}

describe("evaluateSourceUtilization", () => {
/** Helper: run evaluator and assert basic single-source-cited results. */
async function assertSingleCited(env: ReturnType<typeof useLintTempRoot>, expectedCount: number) {
  const result = await evaluateSourceUtilization(env.dir);
  expect(result.totalSources).toBe(1);
  expect(result.citedSources).toBe(1);
  expect(result.perSource[0].citingPageCount).toBe(expectedCount);
  return result;
}

  const env = useLintTempRoot("eval-su");

  it("returns utilizationRate=null when no sources exist", async () => {
    const result = await evaluateSourceUtilization(env.dir);
    expect(result.totalSources).toBe(0);
    expect(result.citedSources).toBe(0);
    expect(result.uncitedSources).toBe(0);
    expect(result.utilizationRate).toBeNull();
    expect(result.perSource).toHaveLength(0);
    expect(result.warnings).toEqual([]);
  });

  it("returns utilizationRate=0 when sources exist but no pages cite them", async () => {
    await env.writeSource("alpha.md", "# Alpha\n\nContent about alpha.");
    await env.writeSource("beta.md", "# Beta\n\nContent about beta.");
    // Write a page that cites nothing
    await env.writeConcept(
      "lonely",
      fm("Lonely") + "This page has no citations at all.\n",
    );

    const result = await evaluateSourceUtilization(env.dir);
    expect(result.totalSources).toBe(2);
    expect(result.citedSources).toBe(0);
    expect(result.uncitedSources).toBe(2);
    expect(result.utilizationRate).toBe(0);
    // Both sources appear in perSource with citingPageCount=0
  });

  it("returns utilizationRate=1 when every source is cited", async () => {
    await env.writeSource("alpha.md", "# Alpha\n\nLine one.\nLine two.\n");
    await env.writeSource("beta.md", "# Beta\n\nLine one.\nLine two.\n");

    await env.writeConcept(
      "page-a",
      fm("Page A") + "Uses alpha.^[alpha.md]\n",
    );
    await env.writeConcept(
      "page-b",
      fm("Page B") + "Uses beta.^[beta.md]\n",
    );

    const result = await evaluateSourceUtilization(env.dir);
    expect(result.totalSources).toBe(2);
    expect(result.citedSources).toBe(2);
    expect(result.uncitedSources).toBe(0);
    expect(result.utilizationRate).toBe(1);
  });

  it("returns correct fractional rate with partial citation coverage", async () => {
    await env.writeSource("cited.md", "# Cited\n\nContent.");
    await env.writeSource("cited-too.md", "# Cited Too\n\nContent.");
    await env.writeSource("uncited.md", "# Uncited\n\nContent.");
    await env.writeSource("also-uncited.md", "# Also\n\nContent.");

    await env.writeConcept(
      "page",
      fm("Page") + "Uses two sources.^[cited.md] And more.^[cited-too.md]\n",
    );

    const result = await evaluateSourceUtilization(env.dir);
    expect(result.totalSources).toBe(4);
    expect(result.citedSources).toBe(2);
    expect(result.uncitedSources).toBe(2);
    expect(result.utilizationRate).toBe(0.5);
  });

  it("perSource entries are sorted by citingPageCount descending", async () => {
    await env.writeSource("popular.md", "# Popular\n\nContent.");
    await env.writeSource("niche.md", "# Niche\n\nContent.");
    await env.writeSource("loner.md", "# Loner\n\nContent.");

    // popular.md cited by 3 pages, niche.md by 1, loner.md by 0
    await env.writeConcept(
      "p1",
      fm("P1") + "Cites popular and niche.^[popular.md] ^[niche.md]\n",
    );
    await env.writeConcept(
      "p2",
      fm("P2") + "Cites popular.^[popular.md]\n",
    );
    await env.writeConcept(
      "p3",
      fm("P3") + "Cites popular.^[popular.md]\n",
    );

    const result = await evaluateSourceUtilization(env.dir);

    // Sorted by citingPageCount desc
    expect(result.perSource[0].sourceFile).toBe("popular.md");
    expect(result.perSource[0].citingPageCount).toBe(3);
    expect(result.perSource[0].citingPages).toEqual(["concepts/p1", "concepts/p2", "concepts/p3"]);

    expect(result.perSource[1].sourceFile).toBe("niche.md");
    expect(result.perSource[1].citingPageCount).toBe(1);
    expect(result.perSource[1].citingPages).toEqual(["concepts/p1"]);
  });

  it("counts claim-level citations (line ranges) correctly", async () => {
    await env.writeSource("src.md", "# Src\n\nLine A.\nLine B.\nLine C.\n");

    await env.writeConcept(
      "precise",
      fm("Precise") + "Specific claim with line range.^[src.md:2-3]\n",
    );

    const result = await assertSingleCited(env, 1);
    expect(result.utilizationRate).toBe(1);
    expect(result.perSource[0].sourceFile).toBe("src.md");
    expect(result.perSource[0].citingPageCount).toBe(1);
  });

  it("counts citations from query pages as well as concept pages", async () => {
    await env.writeSource("shared.md", "# Shared\n\nContent.");

    await env.writeConcept(
      "concept-page",
      fm("Concept") + "Concept page cites shared.^[shared.md]\n",
    );
    await env.writeQuery(
      "query-page",
      fm("Query") + "Query page also cites shared.^[shared.md]\n",
    );

    const result = await assertSingleCited(env, 2);
    expect(result.perSource[0].citingPages).toEqual(["concepts/concept-page", "queries/query-page"]);
  });

  it("handles multi-source citations (^[a.md, b.md]) correctly", async () => {
    await env.writeSource("a.md", "# A\n\nContent A.");
    await env.writeSource("b.md", "# B\n\nContent B.");

    await env.writeConcept(
      "multi",
      fm("Multi") + "Paragraph drawing from two sources.^[a.md, b.md]\n",
    );

    const result = await evaluateSourceUtilization(env.dir);
    expect(result.totalSources).toBe(2);
    expect(result.citedSources).toBe(2);
    expect(result.utilizationRate).toBe(1);
  });

  it("deduplicates the same source cited multiple times on one page", async () => {
    await env.writeSource("dedup.md", "# Dedup\n\nLine one.\nLine two.\nLine three.\n");

    await env.writeConcept(
      "dedup-page",
      fm("Dedup Page") +
        "First mention.^[dedup.md:1-1]\n\n" +
        "Second mention of same source.^[dedup.md:2-3]\n",
    );

    const result = await assertSingleCited(env, 1);
    // cited once per page (deduplicated), so citingPageCount is 1 not 2
  });


  it("distinguishes concept and query pages with the same slug", async () => {
    await env.writeSource("src.md", "# Src\n\nContent.");
    await env.writeConcept(
      "collision",
      fm("Concept Collision") + "Concept page cites src.^[src.md]\n",
    );
    await env.writeQuery(
      "collision",
      fm("Query Collision") + "Query page also cites src.^[src.md]\n",
    );

    const result = await assertSingleCited(env, 2);
    expect(result.perSource[0].citingPages).toEqual(
      expect.arrayContaining(["concepts/collision", "queries/collision"]),
    );
  });

  
  it("ignores citations to nonexistent source files", async () => {
    await env.writeSource("real.md", "# Real\n\nContent.");
    await env.writeConcept(
      "page",
      fm("Page") + "Cites real and a ghost.^[real.md] And a ghost.^[ghost.md]\n",
    );

    const result = await evaluateSourceUtilization(env.dir);
    expect(result.totalSources).toBe(1);
    expect(result.citedSources).toBe(1);
    expect(result.uncitedSources).toBe(0);
    expect(result.utilizationRate).toBe(1);
    const ghostEntry = result.perSource.find(function(e) { return e.sourceFile === "ghost.md"; });
    expect(ghostEntry).toBeUndefined();
  });

  it("excludes symlink sources pointing outside the sources tree", async () => {
    await env.writeSource("ok.md", "# OK\n\nContent.");
    await env.writeConcept("p", fm("P") + "Cites ok.^[ok.md]\n");

    const fs = await import("fs/promises");
    const path = await import("path");
    const leakPath = path.join(env.dir, "sources", "leak.md");
    const outsidePath = path.join(env.dir, "outside.md");
    try {
      await fs.writeFile(outsidePath, "# Outside\n\nLeaked content.");
      await fs.symlink(outsidePath, leakPath);
    } catch {
      return; // symlink not supported on this platform
    }

    const result = await assertSingleCited(env, 1);
    expect(result.utilizationRate).toBe(1);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    // Symlink source leak.md must not appear in perSource
    const leakEntry = result.perSource.find(function(e) { return e.sourceFile === "leak.md"; });
    expect(leakEntry).toBeUndefined();

    await fs.unlink(outsidePath).catch(function() {});
  });
  it("lists all sources in perSource even when uncited", async () => {
    await env.writeSource("orphan.md", "# Orphan\n\nNobody cites me.");

    const result = await evaluateSourceUtilization(env.dir);
    expect(result.totalSources).toBe(1);
    expect(result.citedSources).toBe(0);
    expect(result.uncitedSources).toBe(1);
    expect(result.utilizationRate).toBe(0);
    expect(result.perSource).toHaveLength(1);
    expect(result.perSource[0].sourceFile).toBe("orphan.md");
    expect(result.perSource[0].citingPageCount).toBe(0);
    expect(result.perSource[0].citingPages).toEqual([]);
  });
});
