import { describe, it, expect, beforeEach } from "bun:test";
import { writeFile } from "fs/promises";
import path from "path";
import { buildFrontmatter } from "../src/utils/markdown.js";
import { loadSelectedPages } from "../src/commands/query.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";

/**
 * Tests that the query system loads pages from both wiki/concepts/ and
 * wiki/queries/ directories. Calls the real loadSelectedPages function
 * to validate the actual multi-directory lookup behavior.
 *
 * Validates the "compounding knowledge" principle: saved query answers
 * become retrievable context for future queries.
 */

describe("query page loading from multiple directories", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempRoot("qdir");
  });

  it("loads concept pages from wiki/concepts/", async () => {
    await writePage(path.join(root, "wiki/concepts"), "neural-networks", { title: "Neural Networks", summary: "Summary of Neural Networks" }, "Deep learning basics.");

    const result = await loadSelectedPages(root, ["neural-networks"]);
    expect(result).toContain("Neural Networks");
    expect(result).toContain("Deep learning basics.");
    expect(result).toContain("--- Page: neural-networks ---");
  });

  it("loads saved query pages from wiki/queries/", async () => {
    await writePage(path.join(root, "wiki/queries"), "what-is-backprop", { title: "What is Backprop?", summary: "Summary of What is Backprop?" }, "Backpropagation explained.");

    const result = await loadSelectedPages(root, ["what-is-backprop"]);
    expect(result).toContain("What is Backprop?");
    expect(result).toContain("Backpropagation explained.");
  });

  it("loads pages from both directories in a single query", async () => {
    await writePage(path.join(root, "wiki/concepts"), "transformers", { title: "Transformers", summary: "Summary of Transformers" }, "Attention is all you need.");
    await writePage(path.join(root, "wiki/queries"), "how-do-transformers-work", { title: "How do Transformers work?", summary: "Summary of How do Transformers work?" }, "They use self-attention.");

    const result = await loadSelectedPages(root, ["transformers", "how-do-transformers-work"]);
    expect(result).toContain("--- Page: transformers ---");
    expect(result).toContain("--- Page: how-do-transformers-work ---");
    expect(result).toContain("Attention is all you need.");
    expect(result).toContain("They use self-attention.");
  });

  it("prefers concepts/ over queries/ for same slug", async () => {
    await writePage(path.join(root, "wiki/concepts"), "attention", { title: "Attention (Concept)", summary: "Summary of Attention (Concept)" }, "The concept version.");
    await writePage(path.join(root, "wiki/queries"), "attention", { title: "Attention (Query)", summary: "Summary of Attention (Query)" }, "The query version.");

    const result = await loadSelectedPages(root, ["attention"]);
    expect(result).toContain("Attention (Concept)");
    expect(result).not.toContain("Attention (Query)");
  });

  it("skips missing pages without failing", async () => {
    await writePage(path.join(root, "wiki/concepts"), "exists", { title: "Exists", summary: "Summary of Exists" }, "This page exists.");

    const result = await loadSelectedPages(root, ["exists", "does-not-exist"]);
    expect(result).toContain("--- Page: exists ---");
    expect(result).not.toContain("--- Page: does-not-exist ---");
  });

  it("returns empty string when no pages found", async () => {
    const result = await loadSelectedPages(root, ["nonexistent"]);
    expect(result).toBe("");
  });

  it("skips orphaned pages from query results", async () => {
    const orphanFm = buildFrontmatter({ title: "Stale Concept", summary: "Gone", orphaned: true });
    await writeFile(
      path.join(root, "wiki/concepts/stale-concept.md"),
      `${orphanFm}\n\nThis content should not appear.\n`,
    );
    await writePage(path.join(root, "wiki/concepts"), "fresh", { title: "Fresh", summary: "Summary of Fresh" }, "This is current.");

    const result = await loadSelectedPages(root, ["stale-concept", "fresh"]);
    expect(result).not.toContain("Stale Concept");
    expect(result).toContain("Fresh");
  });

  it("falls through to queries/ when concept is orphaned", async () => {
    const orphanFm = buildFrontmatter({ title: "Attention", summary: "Old", orphaned: true });
    await writeFile(
      path.join(root, "wiki/concepts/attention.md"),
      `${orphanFm}\n\nOrphaned concept.\n`,
    );
    await writePage(path.join(root, "wiki/queries"), "attention", { title: "Attention (Query)", summary: "Summary of Attention (Query)" }, "Live query answer.");

    const result = await loadSelectedPages(root, ["attention"]);
    expect(result).toContain("Attention (Query)");
    expect(result).toContain("Live query answer.");
    expect(result).not.toContain("Orphaned concept.");
  });
});
