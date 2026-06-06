/**
 * Compilation orchestrator for the llmwiki knowledge compiler.
 *
 * Coordinates the full pipeline: lock acquisition, change detection,
 * concept extraction via LLM, wiki page generation with streaming output,
 * orphan marking for deleted sources, interlink resolution, and index
 * generation. Supports incremental compilation — only new or changed
 * sources are processed through the LLM pipeline.
 */

import { readFile, readdir } from "fs/promises";
import path from "path";
import { readState, updateSourceState } from "../utils/state.js";
import {
  buildExtractionSourceStates,
  pickStatesForSources,
} from "./source-state.js";
import {
  atomicWrite,
  buildFrontmatter,
  parseFrontmatter,
  safeReadFile,
  validateWikiPage,
  slugify,
} from "../utils/markdown.js";
import { callClaude } from "../utils/llm.js";
import { acquireLock, releaseLock } from "../utils/lock.js";
import {
  CONCEPT_EXTRACTION_TOOL,
  buildExtractionPrompt,
  buildSeedPagePrompt,
  parseConcepts,
} from "./prompts.js";
import { loadSchema, type SchemaConfig, type SeedPage } from "../schema/index.js";
import { detectChanges, hashFile } from "./hasher.js";
import {
  findAffectedSources,
  findFrozenSlugs,
  findLateAffectedSources,
  freezeFailedExtractions,
  persistFrozenSlugs,
  type ExtractionResult,
} from "./deps.js";
import { markOrphaned, orphanUnownedFrozenPages } from "./orphan.js";
import { resolveLinks } from "./resolver.js";
import { generateIndex } from "./indexgen.js";
import { buildBudgetedCombinedContent, type SourceSlice } from "./prompt-budget.js";
import { addObsidianMeta, generateMOC } from "./obsidian.js";
import { updateEmbeddings } from "../utils/embeddings.js";
import { writeCandidate } from "./candidates.js";
import { appendLog, formatList, formatWikilinkList } from "../utils/activity-log.js";
import {
  checkPageBrokenCitations,
  checkPageCrossLinks,
  checkPageMalformedCitations,
} from "../linter/rules.js";
import type { LintResult } from "../linter/types.js";
import { renderMergedPageContent } from "./page-renderer.js";
import * as output from "../utils/output.js";
import {
  COMPILE_CONCURRENCY,
  CONCEPTS_DIR,
  INDEX_FILE,
  QUERIES_DIR,
  SOURCES_DIR,
} from "../utils/constants.js";
import pLimit from "p-limit";
import type {
  CompileOptions,
  CompileResult,
  ExtractedConcept,
  ReviewCandidate,
  SourceChange,
  SourceState,
  WikiFrontmatter,
  WikiState,
} from "../utils/types.js";

/** Per-source state snapshots keyed by source filename. */
type SourceStateMap = Record<string, SourceState>;

/** Empty CompileResult used when no pipeline work runs (e.g. lock contention). */
function emptyCompileResult(): CompileResult {
  return { compiled: 0, skipped: 0, deleted: 0, concepts: [], pages: [], errors: [] };
}

/**
 * Run the full compilation pipeline with lock protection.
 * Acquires .llmwiki/lock, detects changes, compiles new/changed sources,
 * marks orphaned pages, resolves interlinks, and rebuilds the index.
 * @param root - Project root directory.
 * @param options - Optional pipeline overrides (e.g. --review mode).
 */
export async function compile(root: string, options: CompileOptions = {}): Promise<void> {
  await compileAndReport(root, options);
}

/**
 * Run the full compilation pipeline and return a structured result.
 * Same behaviour as compile() but exposes counts, slugs, and errors so
 * non-CLI consumers (the MCP server, programmatic callers) can report
 * meaningful data without scraping terminal output.
 * @param root - Project root directory.
 * @param options - Optional pipeline overrides (e.g. --review mode).
 * @returns Structured result describing what was compiled.
 */
export async function compileAndReport(
  root: string,
  options: CompileOptions = {},
): Promise<CompileResult> {
  output.header("llmwiki compile");

  const locked = await acquireLock(root);
  if (!locked) {
    output.status("!", output.error("Could not acquire lock. Try again later."));
    return {
      ...emptyCompileResult(),
      errors: ["Could not acquire .llmwiki/lock — another compile is in progress."],
    };
  }

  try {
    return await runCompilePipeline(root, options);
  } finally {
    await releaseLock(root);
  }
}

/** Buckets of source changes used by the compile pipeline. */
interface ChangeBuckets {
  toCompile: SourceChange[];
  deleted: SourceChange[];
  unchanged: SourceChange[];
}

/** Sort source changes into the buckets the pipeline acts on. */
function bucketChanges(changes: SourceChange[]): ChangeBuckets {
  return {
    toCompile: changes.filter((c) => c.status === "new" || c.status === "changed"),
    deleted: changes.filter((c) => c.status === "deleted"),
    unchanged: changes.filter((c) => c.status === "unchanged"),
  };
}

/** Result of phase 2: page writes plus any errors collected along the way. */
interface PageGenerationResult {
  pages: MergedConcept[];
  errors: string[];
  /** Candidate ids written when running in --review mode. Empty otherwise. */
  candidates: string[];
  /**
   * Slugs of seed pages written this run (overview / comparison / entity).
   * Concept pages live on `pages`; seed pages don't fit MergedConcept's
   * source-list shape, so they're tracked separately here. summarizeCompile
   * concatenates these into CompileResult.pages so downstream consumers
   * (MCP, embeddings, programmatic callers) see seed-page changes too.
   */
  seedSlugs: string[];
}

/** Phase 2: generate pages for merged concepts in parallel, capturing errors. */
async function generatePagesPhase(
  root: string,
  extractions: ExtractionResult[],
  frozenSlugs: Set<string>,
  schema: SchemaConfig,
  options: CompileOptions,
): Promise<PageGenerationResult> {
  const merged = mergeExtractions(extractions, frozenSlugs);
  // Build the per-source state snapshot once so each candidate can carry the
  // exact data needed to mark its sources compiled on approval.
  const sourceStates = options.review
    ? await buildExtractionSourceStates(root, extractions)
    : {};
  const limit = pLimit(COMPILE_CONCURRENCY);
  const errors: string[] = [];
  const candidates: string[] = [];
  const pages = await Promise.all(
    merged.map((entry) => limit(async () => {
      const result = await generateMergedPage(root, entry, schema, options, sourceStates);
      if (result.error) errors.push(result.error);
      if (result.candidateId) candidates.push(result.candidateId);
      return entry;
    })),
  );
  return { pages, errors, candidates, seedSlugs: [] };
}

/** Persist source state for every extraction that produced concepts. */
async function persistExtractionStates(
  root: string,
  extractions: ExtractionResult[],
): Promise<void> {
  for (const result of extractions) {
    if (result.concepts.length === 0) continue;
    await persistSourceState(root, result.sourcePath, result.sourceFile, result.concepts);
  }
}

/**
 * Snapshot page IDs already on disk before a compile run, namespaced by
 * directory (e.g. `wiki/concepts/foo`, `wiki/queries/foo`). Namespacing keeps
 * the created/updated split correct when a concept and a query share a slug.
 */
async function listExistingPageIds(root: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const dir of [CONCEPTS_DIR, QUERIES_DIR]) {
    try {
      const files = await readdir(path.join(root, dir));
      for (const file of files) {
        if (file.endsWith(".md")) ids.add(`${dir}/${file.slice(0, -3)}`);
      }
    } catch {
      // Directory may not exist yet on a first compile — nothing to snapshot.
    }
  }
  return ids;
}

/**
 * Journal a non-review compile to log.md: the source files consumed, plus the
 * produced pages split into created (new on disk) and updated (overwritten).
 * Compile only ever writes concept-namespace pages (concept and seed pages both
 * land under wiki/concepts/), so existence is checked against that namespace.
 */
async function logCompile(
  root: string,
  buckets: ChangeBuckets,
  generation: PageGenerationResult,
  existingIds: Set<string>,
): Promise<void> {
  if (buckets.toCompile.length === 0 && buckets.deleted.length === 0) return;
  const produced = [...new Set([...generation.pages.map((entry) => entry.slug), ...generation.seedSlugs])];
  const existed = (slug: string): boolean => existingIds.has(`${CONCEPTS_DIR}/${slug}`);
  const created = produced.filter((slug) => !existed(slug));
  const updated = produced.filter((slug) => existed(slug));
  const heading = `${buckets.toCompile.length} source(s) → ${produced.length} page(s)`;
  const details: string[] = [];
  if (buckets.toCompile.length > 0) {
    details.push(`Sources: ${formatList(buckets.toCompile.map((change) => change.file))}`);
  }
  if (created.length > 0) details.push(`Created: ${formatWikilinkList(created)}`);
  if (updated.length > 0) details.push(`Updated: ${formatWikilinkList(updated)}`);
  if (buckets.deleted.length > 0) details.push(`Deleted sources: ${buckets.deleted.length}`);
  await appendLog(root, "compile", heading, { details });
}

/** Build the structured CompileResult and emit the CLI completion banner. */
function summarizeCompile(
  buckets: ChangeBuckets,
  generation: PageGenerationResult,
  extractions: ExtractionResult[],
  options: CompileOptions,
): CompileResult {
  output.header("Compilation complete");
  output.status("✓", output.success(
    `${buckets.toCompile.length} compiled, ${buckets.unchanged.length} skipped, ${buckets.deleted.length} deleted`,
  ));
  if (options.review && generation.candidates.length > 0) {
    output.status("?", output.info(
      `${generation.candidates.length} candidate(s) awaiting review — run \`llmwiki review list\``,
    ));
  } else if (buckets.toCompile.length > 0) {
    output.status("→", output.dim('Next: llmwiki query "your question here"'));
  }

  const errors = [...generation.errors];
  for (const result of extractions) {
    if (result.concepts.length === 0) {
      errors.push(`No concepts extracted from ${result.sourceFile}`);
    }
  }

  // Concept-page slugs first, then seed-page slugs from the same run, so
  // downstream consumers see every page the compile actually produced.
  // Seed pages are deterministic schema-driven writes; before this they
  // landed on disk silently and never appeared on CompileResult.pages.
  const conceptSlugs = generation.pages.map((entry) => entry.slug);
  const baseResult: CompileResult = {
    compiled: buckets.toCompile.length,
    skipped: buckets.unchanged.length,
    deleted: buckets.deleted.length,
    concepts: generation.pages.map((entry) => entry.concept.concept),
    pages: [...conceptSlugs, ...generation.seedSlugs],
    errors,
  };
  if (options.review) {
    baseResult.candidates = generation.candidates;
  }
  return baseResult;
}

/** Inner pipeline, runs under lock protection. Returns structured CompileResult. */
async function runCompilePipeline(
  root: string,
  options: CompileOptions,
): Promise<CompileResult> {
  const schema = await loadSchema(root);
  reportSchemaStatus(schema);
  const state = await readState(root);
  const changes = await detectChanges(root, state);
  augmentWithAffectedSources(changes, findAffectedSources(state, changes));

  const buckets = bucketChanges(changes);
  if (buckets.toCompile.length === 0 && buckets.deleted.length === 0) {
    output.status("✓", output.success("Nothing to compile — all sources up to date."));
    // Seed pages are cheap deterministic writes — always run them even when
    // no source files changed, so adding a seed page to schema.json takes
    // effect on the next compile without needing a source file edit.
    if (!options.review) {
      const emptyGeneration: PageGenerationResult = {
        pages: [],
        errors: [],
        candidates: [],
        seedSlugs: [],
      };
      await generateSeedPages(root, schema, emptyGeneration);
      // Rebuild index/MOC so the newly-written seed pages become discoverable,
      // and propagate any seed-page validation errors into the returned result.
      await finalizeWiki(root, emptyGeneration.pages, emptyGeneration.seedSlugs);
      return {
        ...emptyCompileResult(),
        skipped: buckets.unchanged.length,
        // Surface seed-page slugs alongside any errors so downstream
        // consumers (MCP, embeddings, programmatic callers) can see what
        // landed even on the no-source-changes early-return path.
        pages: [...emptyGeneration.seedSlugs],
        errors: emptyGeneration.errors,
      };
    }
    return { ...emptyCompileResult(), skipped: buckets.unchanged.length };
  }

  printChangesSummary(changes);
  // In review mode the pipeline contract is "write candidates instead of
  // mutating wiki/". Deletion bookkeeping (orphan marking + frozen-slug
  // persistence) writes directly into wiki/ and updates state.json, so we
  // defer it to the next non-review compile pass. Source-state persistence
  // for compiled sources is also review-deferred — those entries land at
  // approve time so unapproved candidates remain re-detectable on subsequent
  // compiles.
  if (!options.review) {
    await markDeletedAsOrphaned(root, buckets.deleted, state);
  }

  const frozenSlugs = findFrozenSlugs(state, changes);
  reportFrozenSlugs(frozenSlugs);

  const extractions = await runExtractionPhases(root, buckets.toCompile, state, changes);
  if (!options.review) {
    await freezeFailedExtractions(root, extractions, frozenSlugs);
  }

  // Snapshot pages on disk before generation so the journal can tell which
  // produced pages are new (created) versus overwritten (updated).
  const existingIds = await listExistingPageIds(root);
  const generation = await generatePagesPhase(root, extractions, frozenSlugs, schema, options);

  if (!options.review) {
    await persistExtractionStates(root, extractions);
    if (frozenSlugs.size > 0) {
      await orphanUnownedFrozenPages(root, frozenSlugs);
    }
    await persistFrozenSlugs(root, frozenSlugs, extractions);
    // Seed pages write directly into wiki/, so skip them in review mode
    // to honour the "no wiki/ mutation" contract of that mode.
    await generateSeedPages(root, schema, generation);
    await finalizeWiki(root, generation.pages, generation.seedSlugs);
    await logCompile(root, buckets, generation, existingIds);
  }
  return summarizeCompile(buckets, generation, extractions, options);
}

/** Log where the schema was loaded from so the user can confirm it was picked up. */
function reportSchemaStatus(schema: SchemaConfig): void {
  if (schema.loadedFrom) {
    output.status("i", output.dim(`Schema: ${schema.loadedFrom}`));
  }
}

/** Append affected-source changes (logging each addition) to the change list. */
function augmentWithAffectedSources(changes: SourceChange[], affected: string[]): void {
  for (const file of affected) {
    output.status("~", output.info(`${file} [affected by shared concept]`));
    changes.push({ file, status: "changed" });
  }
}

/** Mark wiki pages owned solely by deleted sources as orphaned. */
async function markDeletedAsOrphaned(
  root: string,
  deleted: SourceChange[],
  state: WikiState,
): Promise<void> {
  for (const del of deleted) {
    await markOrphaned(root, del.file, state);
  }
}

/** Log frozen slugs (shared concepts whose deletion-pinned content must persist). */
function reportFrozenSlugs(frozenSlugs: Set<string>): void {
  for (const slug of frozenSlugs) {
    output.status("i", output.dim(`Frozen: ${slug} (shared with deleted source)`));
  }
}

/**
 * Phase 1: extract concepts for the directly-changed batch, then expand to
 * any unchanged sources whose concepts overlap with newly extracted slugs.
 */
async function runExtractionPhases(
  root: string,
  toCompile: SourceChange[],
  state: WikiState,
  allChanges: SourceChange[],
): Promise<ExtractionResult[]> {
  const extractions: ExtractionResult[] = [];
  for (const change of toCompile) {
    extractions.push(await extractForSource(root, change.file));
  }

  const lateAffected = findLateAffectedSources(extractions, state, allChanges);
  for (const file of lateAffected) {
    output.status("~", output.info(`${file} [shares concept with new source]`));
    extractions.push(await extractForSource(root, file));
  }

  return extractions;
}

/**
 * Resolve interlinks, regenerate index/MOC, refresh embeddings
 * post-write. Seed-page slugs are folded into both the changed-slug
 * set (so embeddings refresh covers them) and the new-slug set (so
 * inbound-link resolution scans existing pages for mentions of seed
 * titles). Without that, schema-declared seed pages would land on
 * disk but stay unlinked and absent from the embedding store.
 */
async function finalizeWiki(
  root: string,
  pages: MergedConcept[],
  seedSlugs: string[] = [],
): Promise<void> {
  const conceptChangedSlugs = pages.map((entry) => entry.slug);
  const conceptNewSlugs = pages
    .filter((entry) => entry.concept.is_new)
    .map((entry) => entry.slug);
  const allChangedSlugs = [...conceptChangedSlugs, ...seedSlugs];
  const allNewSlugs = [...conceptNewSlugs, ...seedSlugs];

  if (allChangedSlugs.length > 0) {
    output.status("🔗", output.info("Resolving interlinks..."));
    await resolveLinks(root, allChangedSlugs, allNewSlugs);
  }

  await generateIndex(root);
  await generateMOC(root);
  await safelyUpdateEmbeddings(root, allChangedSlugs);
}

/** Print a summary of detected source file changes. */
function printChangesSummary(changes: SourceChange[]): void {
  const iconMap: Record<string, string> = {
    new: "+", changed: "~", unchanged: ".", deleted: "-",
  };
  const fmtMap: Record<string, (s: string) => string> = {
    new: output.success, changed: output.warn, unchanged: output.dim, deleted: output.error,
  };

  for (const c of changes) {
    const icon = iconMap[c.status] ?? "?";
    const fmt = fmtMap[c.status] ?? output.dim;
    output.status(icon, fmt(`${c.file} [${c.status}]`));
  }
}

/**
 * Phase 1: Extract concepts from a source without generating pages.
 * Returns extraction data for the generation phase.
 */
async function extractForSource(
  root: string,
  sourceFile: string,
): Promise<ExtractionResult> {
  output.status("*", output.info(`Extracting: ${sourceFile}`));

  const sourcePath = path.join(root, SOURCES_DIR, sourceFile);
  const sourceContent = await readFile(sourcePath, "utf-8");
  const existingIndex = await safeReadFile(path.join(root, INDEX_FILE));
  const concepts = await extractConcepts(sourceContent, existingIndex);

  if (concepts.length > 0) {
    const names = concepts.map((c) => c.concept).join(", ");
    output.status("*", output.dim(`  Found ${concepts.length} concepts: ${names}`));
  }
  return { sourceFile, sourcePath, sourceContent, concepts };
}

/** A concept with all contributing sources merged for generation. */
interface MergedConcept {
  slug: string;
  concept: ExtractedConcept;
  sourceFiles: string[];
  combinedContent: string;
}

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
function mergeExtractions(
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

  for (const merged of bySlug.values()) {
    const slices = slicesBySlug.get(merged.slug) ?? [];
    merged.combinedContent = buildBudgetedCombinedContent(
      merged.concept.concept,
      slices,
    );
  }

  return Array.from(bySlug.values());
}

/** Outcome of generating a single merged concept page. */
interface MergedPageOutcome {
  error?: string;
  candidateId?: string;
}

/**
 * Generate a wiki page from merged source content.
 * For shared concepts, the LLM sees content from all contributing sources
 * and frontmatter records every source file. When `options.review` is set,
 * the rendered page is persisted as a review candidate instead of being
 * written into `wiki/`.
 */
async function generateMergedPage(
  root: string,
  entry: MergedConcept,
  schema: SchemaConfig,
  options: CompileOptions,
  sourceStates: SourceStateMap,
): Promise<MergedPageOutcome> {
  const fullPage = await renderMergedPageContent(root, entry, schema);

  if (options.review) {
    return await persistReviewCandidate(root, entry, fullPage, sourceStates, schema);
  }

  const pagePath = path.join(root, CONCEPTS_DIR, `${entry.slug}.md`);
  const error = await writePageIfValid(pagePath, fullPage, entry.concept.concept);
  return { error: error ?? undefined };
}

/** Persist a candidate JSON record for later review and report it on stdout. */
async function persistReviewCandidate(
  root: string,
  entry: MergedConcept,
  fullPage: string,
  sourceStates: SourceStateMap,
  schema: SchemaConfig,
): Promise<MergedPageOutcome> {
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

  const candidate: ReviewCandidate = await writeCandidate(root, {
    title: entry.concept.concept,
    slug: entry.slug,
    summary: entry.concept.summary,
    sources: entry.sourceFiles,
    body: fullPage,
    sourceStates: pickStatesForSources(sourceStates, entry.sourceFiles),
    schemaViolations: schemaViolations.length > 0 ? schemaViolations : undefined,
    provenanceViolations:
      provenanceViolations.length > 0 ? provenanceViolations : undefined,
  });
  output.status("?", output.info(`Candidate ready: ${candidate.id} (${entry.slug})`));
  return { candidateId: candidate.id };
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

/**
 * Materialise schema-declared seed pages (overview, comparison, entity).
 * Each seed page is written under wiki/concepts/ next to concept pages so
 * existing tooling (index, MOC, lint, embeddings) treats them uniformly.
 * Slugs from generated pages this run are added so seed pages can be linked
 * deterministically without waiting for a second compile pass.
 * @param root - Project root directory.
 * @param schema - Resolved schema config.
 * @param generation - Result of the concept-page generation phase.
 */
async function generateSeedPages(
  root: string,
  schema: SchemaConfig,
  generation: PageGenerationResult,
): Promise<void> {
  if (schema.seedPages.length === 0) return;
  for (const seed of schema.seedPages) {
    const result = await generateSingleSeedPage(root, schema, seed);
    if (result.error) {
      generation.errors.push(result.error);
      continue;
    }
    generation.seedSlugs.push(result.slug);
  }
}

/** Outcome of a single seed-page generation: slug always, error when the write failed validation. */
interface SeedPageOutcome {
  slug: string;
  error?: string;
}

/** Build, prompt, and persist a single seed page. */
async function generateSingleSeedPage(
  root: string,
  schema: SchemaConfig,
  seed: SeedPage,
): Promise<SeedPageOutcome> {
  const slug = slugify(seed.title);
  const pagePath = path.join(root, CONCEPTS_DIR, `${slug}.md`);
  const relatedContent = await loadSeedRelatedPages(root, seed.relatedSlugs ?? []);
  const rule = schema.kinds[seed.kind];
  const system = buildSeedPagePrompt(seed, rule, relatedContent);
  const pageBody = await callClaude({
    system,
    messages: [{ role: "user", content: `Write the ${seed.kind} page titled "${seed.title}".` }],
  });

  const now = new Date().toISOString();
  const existing = await safeReadFile(pagePath);
  const existingMeta = existing ? parseFrontmatter(existing).meta : null;
  const createdAt = typeof existingMeta?.createdAt === "string" ? existingMeta.createdAt : now;
  const typedFields: WikiFrontmatter = {
    title: seed.title,
    summary: seed.summary,
    sources: [],
    kind: seed.kind,
    createdAt,
    updatedAt: now,
  };
  const frontmatterFields: Record<string, unknown> = { ...typedFields };
  addObsidianMeta(frontmatterFields, seed.title, []);
  const frontmatter = buildFrontmatter(frontmatterFields);
  const error = await writePageIfValid(pagePath, `${frontmatter}\n\n${pageBody}\n`, seed.title);
  return error ? { slug, error } : { slug };
}

/** Load the bodies of the related concept pages a seed page should weave together. */
async function loadSeedRelatedPages(root: string, slugs: string[]): Promise<string> {
  if (slugs.length === 0) return "";
  const contents: string[] = [];
  for (const slug of slugs) {
    const pagePath = path.join(root, CONCEPTS_DIR, `${slug}.md`);
    const content = await safeReadFile(pagePath);
    if (content) contents.push(content);
  }
  return contents.join("\n\n---\n\n");
}

/**
 * Call Claude to extract concepts from a source document.
 * @param sourceContent - Full source document text.
 * @param existingIndex - Current wiki index for deduplication.
 * @returns Parsed array of extracted concepts.
 */
async function extractConcepts(
  sourceContent: string,
  existingIndex: string,
): Promise<ExtractedConcept[]> {
  const system = buildExtractionPrompt(sourceContent, existingIndex);
  const rawOutput = await callClaude({
    system,
    messages: [{ role: "user", content: "Extract the key concepts from this source." }],
    tools: [CONCEPT_EXTRACTION_TOOL],
  });

  return parseConcepts(rawOutput);
}

/**
 * Validate and atomically write a wiki page, logging the result.
 * @param pagePath - Absolute path to write the page.
 * @param content - Full page content including frontmatter.
 * @param conceptTitle - Title for logging purposes.
 */
async function writePageIfValid(
  pagePath: string,
  content: string,
  conceptTitle: string,
): Promise<string | null> {
  if (!validateWikiPage(content)) {
    output.status("!", output.warn(`Invalid page for "${conceptTitle}" — skipped.`));
    return `Invalid page for "${conceptTitle}" — failed validation`;
  }

  await atomicWrite(pagePath, content);
  return null;
}

/**
 * Refresh the embeddings store without failing compilation.
 * Semantic search is a non-critical enhancement — missing API keys or
 * transient provider errors should produce a warning, not a broken build.
 */
async function safelyUpdateEmbeddings(root: string, changedSlugs: string[]): Promise<void> {
  try {
    await updateEmbeddings(root, changedSlugs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.status("!", output.warn(`Skipped embeddings update: ${message}`));
  }
}

/**
 * Update the persisted state for a compiled source file.
 * @param root - Project root directory.
 * @param sourcePath - Absolute path to the source file.
 * @param sourceFile - Filename within sources/.
 * @param concepts - Concepts extracted from this source.
 */
async function persistSourceState(
  root: string,
  sourcePath: string,
  sourceFile: string,
  concepts: ReturnType<typeof parseConcepts>,
): Promise<void> {
  const hash = await hashFile(sourcePath);
  const entry: SourceState = {
    hash,
    concepts: concepts.map((c) => slugify(c.concept)),
    compiledAt: new Date().toISOString(),
  };

  await updateSourceState(root, sourceFile, entry);
}
