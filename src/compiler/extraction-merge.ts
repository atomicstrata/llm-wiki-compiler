/**
 * Cross-source concept merging for the compilation pipeline.
 *
 * Owns the single responsibility of folding per-source extraction results into
 * one {@link MergedConcept} per slug: reconciling metadata across every source
 * that contributes the same concept (most-pessimistic confidence, merged
 * provenance, unioned contradictions) and building the budgeted combined
 * content sent to the page-generation LLM.
 */

import { slugify } from "../utils/markdown.js";
import { verbose } from "../utils/output.js";
import {
  buildBudgetedCombinedContent,
  resolvePromptBudgetChars,
  type SourceSlice,
} from "./prompt-budget.js";
import type { ExtractionResult } from "./deps.js";
import type { ExtractedConcept } from "../utils/types.js";
import type { MergedConcept } from "./types.js";

/**
 * Reconcile metadata from a later-extracted concept into an existing merged entry.
 * Called when multiple sources contribute the same slug — produces the most
 * pessimistic aggregate view of confidence, provenance, and contradictions.
 *
 * Rules:
 * - confidence: min (most pessimistic value wins)
 * - provenanceState: always 'merged' once two sources are involved
 * - contradictedBy: union by slug (deduplicating on slug identity)
 *
 * `inferredParagraphs` is no longer reconciled — it is derived from the
 * rendered page body at lint time, not from extraction metadata.
 */
export function reconcileConceptMetadata(
  existing: ExtractedConcept,
  incoming: ExtractedConcept,
): ExtractedConcept {
  const reconciled = { ...existing };

  // Minimum confidence — the weaker source's score governs the whole page.
  if (typeof incoming.confidence === "number") {
    reconciled.confidence = typeof existing.confidence === "number"
      ? Math.min(existing.confidence, incoming.confidence)
      : incoming.confidence;
  }

  // Merged state is the canonical answer when multiple sources contribute.
  reconciled.provenanceState = "merged";

  // Union contradictedBy entries, deduplicating by slug.
  const refs = [...(existing.contradictedBy ?? [])];
  const seenSlugs = new Set(refs.map((r) => r.slug));
  for (const ref of incoming.contradictedBy ?? []) {
    if (!seenSlugs.has(ref.slug)) {
      refs.push(ref);
      seenSlugs.add(ref.slug);
    }
  }
  reconciled.contradictedBy = refs.length > 0 ? refs : undefined;

  return reconciled;
}

/**
 * Merge extractions so each concept slug maps to ALL contributing sources.
 * When sources A and B both extract concept X, the LLM receives combined
 * content from both sources, producing a single page that reflects all
 * contributing material rather than just the last source processed.
 * Metadata is reconciled across all contributing concepts via
 * reconcileConceptMetadata so contradictions from later sources are not lost.
 *
 * Combined content is then run through {@link buildBudgetedCombinedContent}
 * so popular concepts that appear in many overlapping sources do not blow
 * past the LLM provider's context window (issue #39). When the raw total
 * fits the budget, the output is byte-identical to the previous unbudgeted
 * concatenation.
 */
export function mergeExtractions(
  extractions: ExtractionResult[],
  frozenSlugs: Set<string>,
): MergedConcept[] {
  const bySlug = new Map<string, MergedConcept>();
  const slicesBySlug = new Map<string, SourceSlice[]>();

  for (const result of extractions) {
    if (result.concepts.length === 0) continue;

    for (const concept of result.concepts) {
      const slug = slugify(concept.concept);
      if (frozenSlugs.has(slug)) continue;

      const existing = bySlug.get(slug);
      if (existing) {
        existing.concept = reconcileConceptMetadata(existing.concept, concept);
        existing.sourceFiles.push(result.sourceFile);
      } else {
        bySlug.set(slug, {
          slug,
          concept,
          sourceFiles: [result.sourceFile],
          combinedContent: "",
        });
        slicesBySlug.set(slug, []);
      }
      slicesBySlug.get(slug)!.push({
        file: result.sourceFile,
        content: result.sourceContent,
      });
    }
  }

  const budget = resolvePromptBudgetChars();
  for (const merged of bySlug.values()) {
    const slices = slicesBySlug.get(merged.slug) ?? [];
    merged.combinedContent = buildBudgetedCombinedContent(
      merged.concept.concept,
      slices,
    );
    verbose(
      `concept ${merged.slug}: ${slices.length} source(s), ` +
      `${merged.combinedContent.length} chars combined (budget ${budget})`,
    );
  }

  return Array.from(bySlug.values());
}
