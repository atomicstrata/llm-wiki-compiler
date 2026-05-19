/**
 * Tests for the wiki linter rules and orchestrator.
 * Each describe block creates a temporary wiki structure, runs a rule,
 * and asserts the expected diagnostics.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "fs/promises";
import {
  checkBrokenWikilinks,
  checkOrphanedPages,
  checkMissingSummaries,
  checkDuplicateConcepts,
  checkEmptyPages,
  checkBrokenCitations,
} from "../src/linter/rules.js";
import { lint } from "../src/linter/index.js";
import { makeLintTempRoot } from "./fixtures/lint-temp-root.js";

let tmpDir: string;
let writeConcept: (slug: string, content: string) => Promise<void>;
let writeQuery: (slug: string, content: string) => Promise<void>;
let writeSource: (name: string, content: string) => Promise<void>;

beforeEach(async () => {
  const fx = await makeLintTempRoot("lint-test");
  tmpDir = fx.root;
  writeConcept = fx.writeConceptPage;
  writeQuery = fx.writeQueryPage;
  writeSource = fx.writeSourceFile;
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("checkBrokenWikilinks", () => {
  it("returns no results when all wikilinks are valid", async () => {
    await writeConcept("machine-learning", "---\ntitle: Machine Learning\n---\nSee [[Neural Networks]].");
    await writeConcept("neural-networks", "---\ntitle: Neural Networks\n---\nA type of ML model.");

    const results = await checkBrokenWikilinks(tmpDir);
    expect(results).toHaveLength(0);
  });

  it("detects broken wikilinks", async () => {
    await writeConcept("machine-learning", "---\ntitle: Machine Learning\n---\nSee [[Nonexistent Topic]].");

    const results = await checkBrokenWikilinks(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].rule).toBe("broken-wikilink");
    expect(results[0].severity).toBe("error");
    expect(results[0].message).toContain("Nonexistent Topic");
  });

  it("resolves wikilinks across concepts and queries", async () => {
    await writeConcept("intro", "---\ntitle: Intro\n---\nSee [[My Query]].");
    await writeQuery("my-query", "---\ntitle: My Query\n---\nAnswer to the query.");

    const results = await checkBrokenWikilinks(tmpDir);
    expect(results).toHaveLength(0);
  });

  it("reports the correct line number for broken wikilinks", async () => {
    const content = "---\ntitle: Test\n---\nLine one.\nLine two.\n[[Missing Page]] here.";
    await writeConcept("test", content);

    const results = await checkBrokenWikilinks(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].line).toBe(6);
  });

  it("resolves wikilinks using pipe alias syntax [[slug|Display Text]]", async () => {
    await writeConcept("target-page", "---\ntitle: Target Page\n---\nTarget content.");
    await writeConcept("source-page", "---\ntitle: Source Page\n---\nSee [[target-page|Custom Label]] for details.");

    const results = await checkBrokenWikilinks(tmpDir);
    expect(results).toHaveLength(0);
  });

  it("reports broken wikilink when pipe alias target does not exist", async () => {
    await writeConcept("source-page", "---\ntitle: Source Page\n---\nSee [[missing-page|Custom Label]] for details.");

    const results = await checkBrokenWikilinks(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].rule).toBe("broken-wikilink");
    expect(results[0].message).toContain("missing-page|Custom Label");
  });
});

describe("checkOrphanedPages", () => {
  it("returns no results when no pages are orphaned", async () => {
    await writeConcept("active-page", "---\ntitle: Active\n---\nContent here.");

    const results = await checkOrphanedPages(tmpDir);
    expect(results).toHaveLength(0);
  });

  it("detects orphaned pages", async () => {
    await writeConcept("orphan", "---\ntitle: Orphan\norphaned: true\n---\nContent here.");

    const results = await checkOrphanedPages(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].rule).toBe("orphaned-page");
    expect(results[0].severity).toBe("warning");
  });
});

describe("checkMissingSummaries", () => {
  it("returns no results when all pages have summaries", async () => {
    await writeConcept("good-page", "---\ntitle: Good\nsummary: A good page.\n---\nContent.");

    const results = await checkMissingSummaries(tmpDir);
    expect(results).toHaveLength(0);
  });

  it("detects pages with missing summary", async () => {
    await writeConcept("no-summary", "---\ntitle: No Summary\n---\nContent here.");

    const results = await checkMissingSummaries(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].rule).toBe("missing-summary");
    expect(results[0].severity).toBe("warning");
  });

  it("detects pages with empty summary", async () => {
    await writeConcept("empty-summary", '---\ntitle: Empty\nsummary: ""\n---\nContent here.');

    const results = await checkMissingSummaries(tmpDir);
    expect(results).toHaveLength(1);
  });
});

describe("checkDuplicateConcepts", () => {
  it("returns no results when all titles are unique", async () => {
    await writeConcept("page-a", "---\ntitle: Page A\n---\nContent A.");
    await writeConcept("page-b", "---\ntitle: Page B\n---\nContent B.");

    const results = await checkDuplicateConcepts(tmpDir);
    expect(results).toHaveLength(0);
  });

  it("detects duplicate titles (case-insensitive)", async () => {
    await writeConcept("ml-intro", "---\ntitle: Machine Learning\n---\nContent A.");
    await writeConcept("ml-guide", "---\ntitle: machine learning\n---\nContent B.");

    const results = await checkDuplicateConcepts(tmpDir);
    expect(results).toHaveLength(2);
    expect(results[0].rule).toBe("duplicate-concept");
    expect(results[0].severity).toBe("error");
  });
});

describe("checkEmptyPages", () => {
  it("returns no results for pages with sufficient body content", async () => {
    const longBody = "This is a sufficiently long body that exceeds the minimum character threshold for content.";
    await writeConcept("full-page", `---\ntitle: Full\n---\n${longBody}`);

    const results = await checkEmptyPages(tmpDir);
    expect(results).toHaveLength(0);
  });

  it("detects pages with empty body", async () => {
    await writeConcept("empty", "---\ntitle: Empty Page\n---\n");

    const results = await checkEmptyPages(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].rule).toBe("empty-page");
    expect(results[0].severity).toBe("warning");
  });

  it("detects pages with very short body", async () => {
    await writeConcept("short", "---\ntitle: Short Page\n---\nToo short.");

    const results = await checkEmptyPages(tmpDir);
    expect(results).toHaveLength(1);
  });

  it("ignores pages without a title", async () => {
    await writeConcept("no-title", "---\nsummary: No title\n---\n");

    const results = await checkEmptyPages(tmpDir);
    expect(results).toHaveLength(0);
  });
});

describe("checkBrokenCitations", () => {
  it("returns no results when all citations are valid", async () => {
    await writeSource("article.md", "# Article\nSome source content.");
    await writeConcept("cited", "---\ntitle: Cited\n---\nBased on ^[article.md] research.");

    const results = await checkBrokenCitations(tmpDir);
    expect(results).toHaveLength(0);
  });

  it("detects broken citations", async () => {
    await writeConcept("bad-cite", "---\ntitle: Bad Cite\n---\nBased on ^[missing.md] data.");

    const results = await checkBrokenCitations(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].rule).toBe("broken-citation");
    expect(results[0].severity).toBe("error");
    expect(results[0].message).toContain("missing.md");
  });

  it("reports the correct line number", async () => {
    const content = "---\ntitle: Test\n---\nLine one.\n^[gone.md] here.";
    await writeConcept("cite-line", content);

    const results = await checkBrokenCitations(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].line).toBe(5);
  });

  it("accepts a multi-source citation where both files exist", async () => {
    await writeSource("a.md", "Source A.");
    await writeSource("b.md", "Source B.");
    await writeConcept("multi", "---\ntitle: Multi\n---\nDrawn from both sources. ^[a.md, b.md]");

    const results = await checkBrokenCitations(tmpDir);
    expect(results).toHaveLength(0);
  });

  it("reports only the missing file in a multi-source citation", async () => {
    await writeSource("a.md", "Source A.");
    await writeConcept("partial", "---\ntitle: Partial\n---\nPartially cited. ^[a.md, missing.md]");

    const results = await checkBrokenCitations(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].message).toContain("missing.md");
    expect(results[0].message).not.toContain("a.md");
  });

  it("does not treat the whole comma-joined text as one filename", async () => {
    await writeSource("a.md", "Source A.");
    await writeSource("b.md", "Source B.");
    // If the rule naively checked "a.md, b.md" as one filename it would fail.
    await writeConcept("joint", "---\ntitle: Joint\n---\nJoint citation. ^[a.md, b.md]");

    const results = await checkBrokenCitations(tmpDir);
    // Neither "a.md" nor "b.md" is missing, so there should be no findings.
    expect(results.some((r) => r.message.includes("a.md, b.md"))).toBe(false);
  });
});

describe("lint orchestrator", () => {
  it("returns a summary with zero counts for a clean wiki", async () => {
    const longBody = "This is a sufficiently long body that exceeds the minimum character threshold for content.";
    await writeConcept("clean", `---\ntitle: Clean Page\nsummary: A clean page.\n---\n${longBody}`);

    const summary = await lint(tmpDir);
    expect(summary.errors).toBe(0);
    expect(summary.warnings).toBe(0);
    expect(summary.info).toBe(0);
    expect(summary.results).toHaveLength(0);
  });

  it("aggregates results from multiple rules", async () => {
    await writeConcept("broken", "---\ntitle: Broken\n---\nSee [[Ghost Page]].");
    await writeConcept("orphan", "---\ntitle: Orphan\norphaned: true\nsummary: ok\n---\nSome sufficiently long body content for the orphan page test case.");

    const summary = await lint(tmpDir);
    const hasWikilinkError = summary.results.some((r) => r.rule === "broken-wikilink");
    const hasOrphanWarning = summary.results.some((r) => r.rule === "orphaned-page");
    expect(hasWikilinkError).toBe(true);
    expect(hasOrphanWarning).toBe(true);
    expect(summary.errors).toBeGreaterThan(0);
    expect(summary.warnings).toBeGreaterThan(0);
  });

  it("works with an empty wiki directory", async () => {
    const summary = await lint(tmpDir);
    expect(summary.errors).toBe(0);
    expect(summary.warnings).toBe(0);
    expect(summary.results).toHaveLength(0);
  });
});
