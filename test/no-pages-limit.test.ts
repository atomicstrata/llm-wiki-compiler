/**
 * The unrestricted extraction mode is opt-in. Keep legacy prompts and parsing
 * by default, isolate concurrent callers, and invalidate snapshots on a switch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildExtractionPrompt, buildPagePrompt, parseConcepts, parseConceptExtraction } from "../src/compiler/prompts.js";
import { activePromptModifiers, noPagesLimitEnabled, promptModifiersDigest, withRunNoPagesLimit } from "../src/compiler/prompt-modifiers.js";
import { extractionSourceHash, reusableExtraction, snapshotExtraction } from "../src/compiler/extraction-snapshot.js";

beforeEach(() => {
  vi.stubEnv("LLMWIKI_OUTPUT_LANG", "");
  vi.stubEnv("LLMWIKI_SOURCES_SECTION", "on");
});
afterEach(() => vi.unstubAllEnvs());

describe("no-pages-limit selection", () => {
  it.each([undefined, false])("preserves the legacy guidance when the option is %s", enabled => {
    withRunNoPagesLimit(enabled, () => {
      expect(buildExtractionPrompt("source", "")).toContain("identify 3-8 distinct, meaningful concepts");
      expect(buildPagePrompt("Topic", "source", "", "")).toContain("If a paragraph is your inference");
      expect(activePromptModifiers()).toEqual({});
    });
  });

  it("removes the requested range and constrains page expansion only when selected", () => {
    withRunNoPagesLimit(true, () => {
      const extraction = buildExtractionPrompt("source", "");
      expect(extraction).not.toContain("3-8");
      expect(extraction).toContain("Return an empty concepts array");
      const page = buildPagePrompt("Topic", "source", "", "");
      expect(page).toContain("A brief source may warrant a brief page");
      expect(page).toContain("Omit claims that the source material does not support");
      expect(page).not.toContain("If a paragraph is your inference");
      expect(activePromptModifiers()).toEqual({ pagesLimit: "off" });
    });
  });

  it("isolates overlapping calls and restores the outer selection", async () => {
    const selections = await Promise.all([true, false].map(enabled => withRunNoPagesLimit(enabled, async () => {
      await Promise.resolve();
      return noPagesLimitEnabled();
    })));
    expect(selections).toEqual([true, false]);
    expect(noPagesLimitEnabled()).toBe(false);
    expect(promptModifiersDigest()).toBe("");
  });

  it("keeps legacy partial parsing while the opt-in parser rejects incomplete assignments", () => {
    const concept = { concept: "Topic", summary: "Supported facts", is_new: true };
    const partial = JSON.stringify({ concepts: [concept, {}] });
    expect(parseConcepts(partial)).toEqual([concept]);
    expect(parseConceptExtraction(partial)).toBeUndefined();
  });

  it("does not reuse a snapshot from the other extraction mode", () => {
    const content = "Source facts.";
    const concepts = [{ concept: "Topic", summary: "Supported facts", is_new: true }];
    const entry = { hash: extractionSourceHash(content), concepts: ["topic"], compiledAt: "2026-10-01T00:00:00Z",
      extraction: snapshotExtraction(content, concepts) };
    expect(reusableExtraction(entry, content)).toHaveLength(1);
    withRunNoPagesLimit(true, () => {
      expect(reusableExtraction(entry, content)).toBeUndefined();
      entry.extraction = snapshotExtraction(content, concepts);
      expect(reusableExtraction(entry, content)).toHaveLength(1);
    });
    expect(reusableExtraction(entry, content)).toBeUndefined();
  });
});
