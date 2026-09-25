/**
 * Extraction reuse is an optimization, never a new source of authority. Pin
 * invalidation, shape validation and published-ownership boundaries separately
 * from the pipeline tests so an unsafe cache hit cannot masquerade as savings.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { reusableExtraction, snapshotExtraction, extractionSourceHash, withExtractionSnapshot } from "../src/compiler/extraction-snapshot.js";
import { withRunSystemPolicy } from "../src/compiler/prompt-modifiers.js";
import { CONCEPT_EXTRACTION_TOOL } from "../src/compiler/prompts.js";
import type { SourceState } from "../src/utils/types.js";

const content = "Evidence for a shared concept.";
const concepts = [{ concept: "Shared", summary: "Supported", is_new: true, confidence: 0.8 }];

/** Produce a committed, matching extraction without invoking any provider. */
function entry(): SourceState {
  return { hash: extractionSourceHash(content), concepts: ["shared"], compiledAt: "now", extraction: snapshotExtraction(content, concepts) };
}

afterEach(() => vi.unstubAllEnvs());

describe("extraction snapshot validity", () => {
  it("preserves the complete metadata on a valid hit", () => {
    expect(reusableExtraction(entry(), content)).toEqual(concepts.map((concept) => ({ ...concept, is_new: false })));
  });

  it("rejects changed bytes even if change detection previously matched", () => {
    expect(reusableExtraction(entry(), `${content} changed`)).toBeUndefined();
  });

  it("rejects a model change", () => {
    vi.stubEnv("LLMWIKI_PROVIDER", "openai");
    vi.stubEnv("LLMWIKI_MODEL", "model-before");
    const prior = entry();
    vi.stubEnv("LLMWIKI_MODEL", "model-after");
    expect(reusableExtraction(prior, content)).toBeUndefined();
  });

  it("rejects a changed caller policy", () => {
    const prior = withRunSystemPolicy("Old instruction", entry);
    expect(withRunSystemPolicy("New instruction", () => reusableExtraction(prior, content))).toBeUndefined();
  });

  it("rejects a changed extraction tool schema without a prompt version bump", () => {
    const prior = entry();
    const field = CONCEPT_EXTRACTION_TOOL.input_schema.properties.concepts.items.properties.summary;
    const description = field.description;
    try {
      field.description = "A detailed evidence summary";
      expect(reusableExtraction(prior, content)).toBeUndefined();
      expect(reusableExtraction(entry(), content)).toBeDefined();
    } finally {
      field.description = description;
    }
    expect(reusableExtraction(prior, content)).toBeDefined();
  });

  it.each([null, {}, { fingerprint: 7 }, { concepts: [null] }])("ignores malformed optional snapshots: %j", (bad) => {
    const prior = entry();
    Object.assign(prior, { extraction: bad });
    expect(reusableExtraction(prior, content)).toBeUndefined();
  });

  it("rejects ownership drift and retry hashes", () => {
    expect(reusableExtraction({ ...entry(), concepts: [] }, content)).toBeUndefined();
    expect(reusableExtraction({ ...entry(), hash: "" }, content)).toBeUndefined();
  });

  it("does not snapshot partially held or failed page generations", () => {
    const prior = entry();
    delete prior.extraction;
    const result = { sourceFile: "s.md", sourcePath: "/unused", sourceContent: content, concepts };
    expect(withExtractionSnapshot(prior, result, [])).not.toHaveProperty("extraction");
    expect(withExtractionSnapshot(prior, result, ["shared"])).toHaveProperty("extraction");
  });
});
