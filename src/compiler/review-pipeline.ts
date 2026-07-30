/**
 * Per-page review-candidate generation pipeline for the compiler.
 *
 * Owns the single responsibility of turning one {@link MergedConcept} into a
 * {@link MergedPageOutcome}: render the page, run schema- and provenance-aware
 * lint, evaluate the review policy, and EITHER persist a review candidate
 * (forced `--review` or policy-held) OR return a deferred live-write for the
 * caller to commit as a journalled batch.
 */

import path from "path";
import {
  parseFrontmatter,
  parseProvenanceMetadata,
  validateWikiPage,
} from "../utils/markdown.js";
import { pickStatesForSources } from "./source-state.js";
import { renderMergedPageContent } from "./page-renderer.js";
import { deleteCandidateBySlug, writeCandidate } from "./candidates.js";
import {
  checkPageBrokenCitations,
  checkPageCrossLinks,
  checkPageMalformedCitations,
} from "../linter/rules.js";
import type { LintResult } from "../linter/types.js";
import * as output from "../utils/output.js";
import { evaluatePolicy } from "../review/policy.js";
import type { HeldReason, ReviewPolicy } from "../review/policy.js";
import { SOURCES_DIR } from "../utils/constants.js";
import type { SchemaConfig } from "../schema/index.js";
import type {
  CompileOptions,
  ReviewCandidate,
} from "../utils/types.js";
import type {
  MergedConcept,
  MergedPageOutcome,
  SourceStateMap,
} from "./types.js";

/** Review diagnostics computed from the final generated page. */
interface ReviewDiagnostics {
  schemaViolations: LintResult[];
  provenanceViolations: LintResult[];
}

/** Metadata needed when persisting a candidate. */
interface ReviewCandidateMeta {
  reviewMode: "policy" | "forced";
  heldReasons: HeldReason[];
}

/**
 * Generate a wiki page from merged source content.
 * For shared concepts, the LLM sees content from all contributing sources
 * and frontmatter records every source file. When `options.review` is set,
 * the rendered page is persisted as a review candidate instead of being
 * written into `wiki/`.
 */
export async function generateMergedPage(
  root: string,
  entry: MergedConcept,
  schema: SchemaConfig,
  options: CompileOptions,
  sourceStates: SourceStateMap,
  policy: ReviewPolicy,
): Promise<MergedPageOutcome> {
  const fullPage = await renderMergedPageContent(root, entry, schema, options.systemPolicy);
  const diagnostics = await collectReviewDiagnostics(root, entry, fullPage, schema);
  const signals = buildPolicySignals(fullPage, diagnostics);
  const reasons = evaluatePolicy(signals, policy);

  if (options.review) {
    const heldReasons = [{ code: "manual-review-requested" } as HeldReason, ...reasons];
    return await persistReviewCandidate(root, entry, fullPage, sourceStates, diagnostics, signals, {
      reviewMode: "forced",
      heldReasons,
    });
  }

  if (reasons.length > 0) {
    return await persistReviewCandidate(root, entry, fullPage, sourceStates, diagnostics, signals, {
      reviewMode: "policy",
      heldReasons: reasons,
    });
  }

  // Live-write branch: run the same validate prefilter (skip-invalid), then
  // DEFER the write — return it as a pending CompilePageWrite so the caller can
  // apply every page as one journalled executor batch (instead of an inline
  // atomicWrite here). Generation only ever writes concept-namespace pages.
  if (!validateWikiPage(fullPage)) {
    output.status("!", output.warn(`Invalid page for "${entry.concept.concept}" — skipped.`));
    return { error: `Invalid page for "${entry.concept.concept}" — failed validation` };
  }
  await deleteCandidateBySlug(root, entry.slug);
  return { liveWrite: { namespace: "concepts", slug: entry.slug, body: fullPage } };
}

/** Persist a candidate JSON record for later review and report it on stdout. */
async function collectReviewDiagnostics(
  root: string,
  entry: MergedConcept,
  fullPage: string,
  schema: SchemaConfig,
): Promise<ReviewDiagnostics> {
  // Run schema-aware AND provenance-aware lint against the candidate body so
  // both classes of violation are visible in `review show` before a reviewer
  // approves the page. The virtual file path uses the slug so diagnostics
  // are identifiable without a real disk path. Provenance lint covers the
  // citation rules that previously only ran on the post-promotion compile.
  const virtualPath = `wiki/concepts/${entry.slug}.md`;
  const schemaViolations = checkPageCrossLinks(fullPage, virtualPath, schema);
  const provenanceViolations = await collectCandidateProvenanceViolations(
    root,
    fullPage,
    virtualPath,
  );
  return { schemaViolations, provenanceViolations };
}

/** Build review-policy signals from final page frontmatter and diagnostics. */
function buildPolicySignals(fullPage: string, diagnostics: ReviewDiagnostics) {
  const { meta } = parseFrontmatter(fullPage);
  const provenance = parseProvenanceMetadata(meta);
  return {
    confidence: provenance.confidence,
    contradicted: (provenance.contradictedBy?.length ?? 0) > 0,
    schemaViolations: diagnostics.schemaViolations,
    provenanceViolations: diagnostics.provenanceViolations,
  };
}

/** Persist a candidate JSON record for later review and report it on stdout. */
async function persistReviewCandidate(
  root: string,
  entry: MergedConcept,
  fullPage: string,
  sourceStates: SourceStateMap,
  diagnostics: ReviewDiagnostics,
  signals: ReturnType<typeof buildPolicySignals>,
  meta: ReviewCandidateMeta,
): Promise<MergedPageOutcome> {
  const candidate: ReviewCandidate = await writeCandidate(root, {
    title: entry.concept.concept,
    slug: entry.slug,
    summary: entry.concept.summary,
    sources: entry.sourceFiles,
    body: fullPage,
    sourceStates: pickStatesForSources(sourceStates, entry.sourceFiles),
    schemaViolations:
      diagnostics.schemaViolations.length > 0 ? diagnostics.schemaViolations : undefined,
    provenanceViolations:
      diagnostics.provenanceViolations.length > 0 ? diagnostics.provenanceViolations : undefined,
    reviewMode: meta.reviewMode,
    heldReasons: meta.heldReasons,
    confidence: signals.confidence,
    contradicted: signals.contradicted,
  });
  output.status("?", output.info(`Candidate ready: ${candidate.id} (${entry.slug})`));
  return {
    candidate: {
      id: candidate.id,
      mode: meta.reviewMode === "policy" ? "held" : "forced",
      ref: { id: candidate.id, slug: entry.slug, reasons: meta.heldReasons.map((r) => r.code) },
    },
  };
}

/**
 * Run the in-memory provenance lint rules against a candidate body:
 * malformed claim citations + broken-source / out-of-bounds line spans.
 * Returns the combined diagnostics so writeCandidate can persist them.
 */
async function collectCandidateProvenanceViolations(
  root: string,
  fullPage: string,
  virtualPath: string,
): Promise<LintResult[]> {
  const malformed = checkPageMalformedCitations(fullPage, virtualPath);
  const broken = await checkPageBrokenCitations(
    fullPage,
    virtualPath,
    path.join(root, SOURCES_DIR),
  );
  return [...malformed, ...broken];
}
