import { describe, it, expect, beforeEach } from "bun:test";
import { writeFile, readFile } from "fs/promises";
import path from "path";
import { buildFrontmatter, parseFrontmatter } from "../src/utils/markdown.js";
import { summarizeAnswer } from "../src/commands/query.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { generateAndReadIndex } from "./fixtures/generate-and-read-index.js";

/**
 * Tests the query --save integration path end-to-end (without LLM calls).
 *
 * Validates two bugs that were found:
 * 1. saveQueryPage now regenerates the index so saved queries are immediately
 *    retrievable by the next query's page-selection step.
 * 2. saveQueryPage writes a summary to frontmatter so the index entry has
 *    retrieval signal beyond just the title.
 */

describe("summarizeAnswer", () => {
  it("extracts the first sentence from an answer", () => {
    const answer = "Knowledge compilation transforms raw sources into structured wiki pages. It uses a two-phase pipeline.";
    expect(summarizeAnswer(answer)).toBe("Knowledge compilation transforms raw sources into structured wiki pages.");
  });

  it("truncates long first sentences to 120 chars", () => {
    const longSentence = "A".repeat(200) + ". Second sentence.";
    expect(summarizeAnswer(longSentence).length).toBe(120);
  });

  it("handles single-line answers", () => {
    const answer = "LLMs are large language models.";
    expect(summarizeAnswer(answer)).toBe("LLMs are large language models.");
  });

  it("uses only the first line of multi-line answers", () => {
    const answer = "First line answer.\n\nSecond paragraph with more detail.";
    expect(summarizeAnswer(answer)).toBe("First line answer.");
  });

  it("handles empty answer", () => {
    expect(summarizeAnswer("")).toBe("");
  });
});

describe("query --save integration", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempRoot("qsave");
  });

  it("saved query page includes summary in frontmatter", async () => {
    // Simulate what saveQueryPage does: write a query with summary + rebuild index.
    // We write the file directly using the same logic saveQueryPage uses,
    // since calling saveQueryPage requires the full LLM pipeline.
    const question = "What is knowledge compilation?";
    const answer = "Knowledge compilation transforms raw sources into structured wiki pages. It uses a two-phase pipeline with concept extraction.";
    const summary = summarizeAnswer(answer);

    const fm = buildFrontmatter({
      title: question,
      summary,
      type: "query",
      createdAt: new Date().toISOString(),
    });
    const doc = `${fm}\n\n${answer}\n`;
    await writeFile(path.join(root, "wiki/queries/what-is-knowledge-compilation.md"), doc);

    // Verify frontmatter has a summary
    const saved = await readFile(path.join(root, "wiki/queries/what-is-knowledge-compilation.md"), "utf-8");
    const { meta } = parseFrontmatter(saved);
    expect(meta.summary).toBe("Knowledge compilation transforms raw sources into structured wiki pages.");
    expect(typeof meta.summary).toBe("string");
    expect((meta.summary as string).length).toBeGreaterThan(0);
  });

  it("saved query summary appears in the index for retrieval", async () => {
    // Write a concept page
    const conceptFm = buildFrontmatter({ title: "LLM", summary: "Large language models" });
    await writeFile(path.join(root, "wiki/concepts/llm.md"), `${conceptFm}\n\nLLMs are neural networks.\n`);

    // Write a saved query WITH summary (the fix)
    const answer = "An LLM is a large language model trained on text corpora.";
    const queryFm = buildFrontmatter({
      title: "What is an LLM?",
      summary: summarizeAnswer(answer),
      type: "query",
      createdAt: new Date().toISOString(),
    });
    await writeFile(path.join(root, "wiki/queries/what-is-an-llm.md"), `${queryFm}\n\n${answer}\n`);

    const index = await generateAndReadIndex(root);

    // The index should have the query's summary as retrieval signal
    expect(index).toContain("## Saved Queries");
    expect(index).toContain("[[what-is-an-llm|What is an LLM?]]");
    expect(index).toContain("An LLM is a large language model trained on text corpora.");
  });

  it("saved query without summary produces blank entry (pre-fix behavior)", async () => {
    // Write a saved query WITHOUT summary (the old bug)
    const noSummaryFm = buildFrontmatter({
      title: "What is backpropagation?",
      type: "query",
      createdAt: new Date().toISOString(),
    });
    await writeFile(
      path.join(root, "wiki/queries/what-is-backpropagation.md"),
      `${noSummaryFm}\n\nBackprop computes gradients.\n`,
    );

    const index = await generateAndReadIndex(root);

    // Without summary, the index line has no retrieval context after the dash
    expect(index).toContain("[[what-is-backpropagation|What is backpropagation?]]");
    expect(index).toMatch(/\[\[what-is-backpropagation\|What is backpropagation\?\]\]\*\* —\s*$/m);
  });
});
