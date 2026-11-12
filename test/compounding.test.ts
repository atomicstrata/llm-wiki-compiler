import { describe, it, expect, beforeEach } from "bun:test";
import path from "path";
import { loadSelectedPages } from "../src/commands/query.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import { generateAndReadIndex } from "./fixtures/generate-and-read-index.js";

/**
 * Integration test for the knowledge compounding loop.
 *
 * Validates the core idea from Karpathy's LLM Wiki pattern: "good answers
 * can be filed back into the wiki as new pages... your explorations compound."
 *
 * The loop: ingest -> compile -> query --save -> recompile -> query finds saved answer.
 * Uses the real generateIndex and loadSelectedPages functions to test the
 * actual pipeline, not reimplementations.
 */

describe("knowledge compounding loop", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempRoot("compound");
  });

  it("saved query appears in the index alongside concepts", async () => {
    // Step 1: Simulate compiled concept pages
    await writePage(
      path.join(root, "wiki/concepts"), "knowledge-compilation",
      { title: "Knowledge Compilation", summary: "Compiling knowledge with LLMs" },
      "Knowledge compilation is the process of using LLMs to structure raw information.",
    );

    // Step 2: Simulate a saved query answer (what `llmwiki query --save` produces)
    await writePage(
      path.join(root, "wiki/queries"), "what-is-knowledge-compilation",
      { title: "What is Knowledge Compilation?", type: "query", createdAt: "2026-04-05T00:00:00.000Z" },
      "Knowledge compilation uses LLMs to transform messy sources into structured wiki pages. See [[Knowledge Compilation]].",
    );

    // Step 3+4: Regenerate the index and verify it includes both pages
    const index = await generateAndReadIndex(root);

    expect(index).toContain("## Concepts");
    expect(index).toContain("[[knowledge-compilation|Knowledge Compilation]]");
    expect(index).toContain("## Saved Queries");
    expect(index).toContain("[[what-is-knowledge-compilation|What is Knowledge Compilation?]]");
    expect(index).toContain("2 pages");
  });

  it("saved query is loadable as context for future queries via real loadSelectedPages", async () => {
    // Simulate a previously saved query
    await writePage(
      path.join(root, "wiki/queries"), "how-does-incremental-compile-work",
      { title: "How Does Incremental Compile Work?", type: "query", createdAt: "2026-04-05T00:00:00.000Z" },
      "Incremental compilation uses SHA-256 hashes to detect changed sources. Only changed sources go through the LLM pipeline.",
    );

    // The real loadSelectedPages should find this in wiki/queries/
    const result = await loadSelectedPages(root, ["how-does-incremental-compile-work"]);

    expect(result).toContain("--- Page: how-does-incremental-compile-work ---");
    expect(result).toContain("SHA-256");
    expect(result).toContain("Incremental compilation");
  });

  it("concepts and queries both load when selecting mixed page sets", async () => {
    await writePage(
      path.join(root, "wiki/concepts"), "wikilinks",
      { title: "Wikilinks", summary: "Internal linking between pages" },
      "Wikilinks connect related concepts using [[double bracket]] syntax.",
    );

    await writePage(
      path.join(root, "wiki/queries"), "what-are-wikilinks",
      { title: "What are Wikilinks?", type: "query", createdAt: "2026-04-05T00:00:00.000Z" },
      "Wikilinks are the linking syntax used to connect wiki pages. See [[Wikilinks]].",
    );

    const result = await loadSelectedPages(root, ["wikilinks", "what-are-wikilinks"]);

    expect(result).toContain("--- Page: wikilinks ---");
    expect(result).toContain("--- Page: what-are-wikilinks ---");
    expect(result).toContain("double bracket");
    expect(result).toContain("linking syntax");
  });

  it("the compounding loop increases total page count over time", async () => {
    // Round 1: Just concepts
    await writePage(
      path.join(root, "wiki/concepts"), "llm",
      { title: "LLM", summary: "Large Language Models" },
      "LLMs are neural networks trained on text.",
    );
    let index = await generateAndReadIndex(root);
    expect(index).toContain("1 pages");

    // Round 2: User asks a question and saves it -> page count grows
    await writePage(
      path.join(root, "wiki/queries"), "what-is-an-llm",
      { title: "What is an LLM?", type: "query", createdAt: "2026-04-05T00:00:00.000Z" },
      "An LLM is a large language model. See [[LLM]].",
    );
    index = await generateAndReadIndex(root);
    expect(index).toContain("2 pages");

    // Verify the saved query is also retrievable
    const loaded = await loadSelectedPages(root, ["what-is-an-llm"]);
    expect(loaded).toContain("large language model");

    // Round 3: Another query compounds further
    await writePage(
      path.join(root, "wiki/queries"), "how-are-llms-trained",
      { title: "How are LLMs trained?", type: "query", createdAt: "2026-04-05T00:00:00.000Z" },
      "LLMs are trained on massive text corpora. See [[LLM]].",
    );
    index = await generateAndReadIndex(root);
    expect(index).toContain("3 pages");
  });
});
