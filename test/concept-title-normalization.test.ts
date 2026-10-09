/**
 * Replay the observed Elena Rossi extraction through the real parser, merge
 * and renderer. Only the nondeterministic LLM prose response is stubbed.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConcepts } from "../src/compiler/prompts.js";
import { mergeExtractions } from "../src/compiler/extraction-merge.js";
import { renderMergedPageContent } from "../src/compiler/page-renderer.js";
import { parseFrontmatter } from "../src/utils/markdown.js";
import { buildDefaultSchema } from "../src/schema/index.js";
import type { ExtractionResult } from "../src/compiler/deps.js";
import { extractionSourceHash, reusableExtraction, snapshotExtraction } from "../src/compiler/extraction-snapshot.js";

vi.mock("../src/utils/llm.js", () => ({ callClaude: vi.fn(async () => "# Elena Rossi\n\nQuality manager.") }));

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** Feed a fixed structured model response into the actual extraction parser. */
function extracted(sourceFile: string, concept: string): ExtractionResult {
  return {
    sourceFile, sourcePath: sourceFile, sourceContent: "Elena Rossi approves the final pack.",
    concepts: parseConcepts(JSON.stringify({ concepts: [{ concept, summary: "Quality manager", is_new: true }] })),
  };
}

describe("wikilink concept identity", () => {
  it.each(["[[Elena Rossi]]", "[[Elena-Rossi|Elena Rossi]]"])("rejects legacy cached markup %s", concept => {
    const content = "Elena Rossi approves deliveries.";
    const concepts = [{ concept, summary: "Quality manager", is_new: false }];
    const entry = {
      hash: extractionSourceHash(content), concepts: ["elena-rossielena-rossi"], compiledAt: "2026-09-30T00:00:00Z",
      extraction: snapshotExtraction(content, concepts),
    };
    if (concept === "[[Elena Rossi]]") entry.concepts = ["elena-rossi"];
    expect(reusableExtraction(entry, content)).toBeUndefined();
  });

  it.each([false, true])("renders one clean page and preserves both sources (linked first: %s)", async linkedFirst => {
    const root = await mkdtemp(path.join(tmpdir(), "llmwiki-title-diagnosis-"));
    roots.push(root);
    const extractions = [
      extracted("person.md", "Elena Rossi"),
      extracted("delivery.md", "[[Elena-Rossi|Elena Rossi]]"),
    ];
    if (linkedFirst) extractions.reverse();
    const pages = mergeExtractions(extractions, new Set());
    const rendered = await Promise.all(pages.map(async page => ({
      slug: page.slug,
      title: parseFrontmatter(await renderMergedPageContent(root, page, buildDefaultSchema())).meta.title,
    })));
    expect(rendered).toEqual([{ slug: "elena-rossi", title: "Elena Rossi" }]);
    expect([...pages[0].sourceFiles].sort()).toEqual(["delivery.md", "person.md"]);
  });

  it.each([
    ["[[Elena Rossi]]", "Elena Rossi"],
    ["[[Elena-Rossi| Elena Rossi ]]", "Elena Rossi"],
    ["[[documentazione-correlata|Documentazione Correlata]]", "Documentazione Correlata"],
    ["[[qualità|Qualità]] e [[gestione|Gestione]]", "Qualità e Gestione"],
    ["Limits [mm]", "Limits [mm]"],
    ["[[incomplete", "[[incomplete"],
  ])("normalizes concept markup %s without altering ordinary text", (input, expected) => {
    expect(extracted("source.md", input).concepts[0].concept).toBe(expected);
  });
});
