/**
 * Compile-time pin for the shared ProvenanceMetadata shape.
 *
 * Codex's post-merge schema-overlap audit flagged that ExtractedConcept
 * and WikiFrontmatter independently re-declared the same provenance
 * fields (confidence, provenanceState, contradictedBy), which was a
 * drift hazard. The fix composes both surfaces from a single exported
 * `ProvenanceMetadata` interface in src/utils/types.ts, plus drops the
 * duplicate private interface that lived in src/utils/markdown.ts.
 *
 * The two type-level assertions at the top are the strict guard: they
 * compile only when every key present on ProvenanceMetadata is also a
 * key of ExtractedConcept / WikiFrontmatter. Removing the `extends`
 * clause and inlining the fields would still pass — but DROPPING any
 * ProvenanceMetadata key from one of the two surfaces (the actual
 * drift codex worried about) would break `npx tsc --noEmit`.
 *
 * The runtime assignment tests below are weaker (every field is
 * optional, so an unrelated empty object would also be assignable) but
 * exercise the runtime field shape end-to-end.
 */

import { describe, it, expect } from "bun:test";
import type {
  ExtractedConcept,
  ProvenanceMetadata,
  WikiFrontmatter,
} from "../src/utils/types.js";

// Type-level assertions — fail to compile if ExtractedConcept or
// WikiFrontmatter no longer carry every key from ProvenanceMetadata.
// Conditional resolves to `true` when the keys are a superset, otherwise
// to `never`, which would make the constant assignment fail tsc.
type AssertExtractedConceptCoversProvenance =
  keyof ProvenanceMetadata extends keyof ExtractedConcept ? true : never;
type AssertWikiFrontmatterCoversProvenance =
  keyof ProvenanceMetadata extends keyof WikiFrontmatter ? true : never;
const _extractedConceptCovers: AssertExtractedConceptCoversProvenance = true;
const _wikiFrontmatterCovers: AssertWikiFrontmatterCoversProvenance = true;
// Reference the constants so a future "unused variable" sweep keeps them.
void _extractedConceptCovers;
void _wikiFrontmatterCovers;

describe("ProvenanceMetadata shared shape", () => {
  it("ExtractedConcept carries every ProvenanceMetadata field at runtime", () => {
    const concept: ExtractedConcept = {
      concept: "Concept",
      summary: "summary",
      is_new: true,
      confidence: 0.9,
      provenanceState: "extracted",
      contradictedBy: [{ slug: "other" }],
    };
    const provenance: ProvenanceMetadata = concept;
    expect(provenance.confidence).toBe(0.9);
    expect(provenance.provenanceState).toBe("extracted");
  });

  it("WikiFrontmatter carries every ProvenanceMetadata field at runtime", () => {
    const frontmatter: WikiFrontmatter = {
      title: "Sample",
      summary: "An example.",
      sources: ["src.md"],
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z",
      confidence: 0.8,
      provenanceState: "merged",
      contradictedBy: [{ slug: "alt" }],
    };
    const provenance: ProvenanceMetadata = frontmatter;
    expect(provenance.contradictedBy).toEqual([{ slug: "alt" }]);
    expect(provenance.confidence).toBe(0.8);
  });
});
