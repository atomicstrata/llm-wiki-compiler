/**
 * Compilation orchestrator for the llmwiki knowledge compiler.
 *
 * Coordinates the full pipeline: lock acquisition, change detection,
 * concept extraction via LLM, wiki page generation with streaming output,
 * orphan marking for deleted sources, interlink resolution, and index
 * generation. Supports incremental compilation — only new or changed
 * sources are processed through the LLM pipeline.
 */

import { readdir } from "fs/promises";
import path from "path";
import { CompileStateDraft } from "./compile-state-draft.js";
import {
  recoverJournalBeforeCompile,
  JournalUnsafeError,
} from "../trust/journal-recovery.js";
import {
  buildExtractionSourceStates,
} from "./source-state.js";
import {
  slugify,
} from "../utils/markdown.js";
import { acquireLock, releaseLock } from "../utils/lock.js";
import {
  parseConcepts,
} from "./prompts.js";
import { loadSchema, type SchemaConfig } from "../schema/index.js";
import { detectChanges, hashFile } from "./hasher.js";
import {
  promoteForPromptModifiers,
  promptModifiersDigest,
  withRunSystemPolicy,
} from "./prompt-modifiers.js";
import {
  findAffectedSources,
  findReconciliationSlugs,
  freezeFailedExtractions,
  persistFrozenSlugs,
  type ExtractionResult,
} from "./deps.js";
import { markOrphaned, orphanUnownedFrozenPages } from "./orphan.js";
import { resolveAndApplyLinks } from "./resolver.js";
import { generateIndex } from "./indexgen.js";
import { generateMOC } from "./obsidian.js";
import { qualifiedPageId } from "../utils/page-id.js";
import { refreshEmbeddingsDrainingPending } from "../utils/embeddings-refresh.js";
import { listCandidates } from "./candidates.js";
import {
  applyCompilePageWritesLocked,
} from "./compile-write.js";
import * as output from "../utils/output.js";
import { verbose } from "../utils/output.js";
import { loadReviewPolicy } from "../review/config.js";
import { isPolicyOff } from "../review/policy.js";
import type { ReviewPolicy } from "../review/policy.js";
import {
  CONCEPTS_DIR,
  QUERIES_DIR,
  SOURCES_DIR,
} from "../utils/constants.js";
import { resolveCompileConcurrency } from "./concurrency.js";
import pLimit from "p-limit";
import { mergeExtractions } from "./extraction-merge.js";
import { runExtractionPhases } from "./extraction-phase.js";
import { generateMergedPage } from "./review-pipeline.js";
import { generateSeedPages } from "./seed-pages.js";
import {
  logCompile,
  printChangesSummary,
  reportFrozenSlugs,
  reportSchemaStatus,
  summarizeCompile,
} from "./compile-report.js";
import type {
  ChangeBuckets,
  MergedConcept,
  MergedPageOutcome,
  PageGenerationResult,
} from "./types.js";
import type {
  CompileOptions,
  CompileResult,
  ReviewedCandidateRef,
  SourceChange,
  SourceState,
} from "../utils/types.js";

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
    // STRICT replay-before-read: recover any pending journal to its pre-state
    // BEFORE the pipeline reads state or touches pages. An `unsafe` journal
    // (escaping/malformed/escaping-target) aborts the compile loudly — no reads,
    // no writes — rather than compounding a possibly-inconsistent page store.
    // The `finally` below still releases the lock on this abort path.
    const recovery = await recoverJournalBeforeCompile(root);
    if (recovery.status === "unsafe") {
      throw new JournalUnsafeError("pre-compile journal recovery unsafe");
    }
    // The policy is established for the WHOLE run, before change detection, so
    // the modifier digest it contributes is visible to the invalidation check
    // rather than only to the prompt builders further down.
    return await withRunSystemPolicy(options.systemPolicy, () =>
      runCompilePipeline(root, options),
    );
  } finally {
    await releaseLock(root);
  }
}

/** Sort source changes into the buckets the pipeline acts on. */
function bucketChanges(changes: SourceChange[]): ChangeBuckets {
  return {
    toCompile: changes.filter((c) => c.status === "new" || c.status === "changed"),
    deleted: changes.filter((c) => c.status === "deleted"),
    unchanged: changes.filter((c) => c.status === "unchanged"),
  };
}

/** Phase 2: generate pages for merged concepts in parallel, capturing errors. */
async function generatePagesPhase(
  root: string,
  extractions: ExtractionResult[],
  frozenSlugs: Set<string>,
  reconciliationSlugs: ReadonlySet<string>,
  schema: SchemaConfig,
  options: CompileOptions,
  policy: ReviewPolicy,
  concurrency: number,
): Promise<PageGenerationResult> {
  const merged = mergeExtractions(extractions, frozenSlugs, reconciliationSlugs);
  // Build the per-source state snapshot once so each candidate can carry the
  // exact data needed to mark its sources compiled on approval.
  const shouldBuildSourceStates = options.review || !isPolicyOff(policy);
  const sourceStates = shouldBuildSourceStates
    ? await buildExtractionSourceStates(root, extractions)
    : {};
  const limit = pLimit(concurrency);
  // Collect per-outcome errors and candidate info into the ordered outcomes array
  // AFTER Promise.all, then derive candidates/review by iterating outcomes in source order.
  // This ensures stable, source-order ordering regardless of parallel completion timing.
  const outcomes = await Promise.all(
    merged.map((entry) => limit(async () => {
      const result = await generateMergedPage(root, entry, schema, options, sourceStates, policy);
      return { entry, result };
    })),
  );
  const errors: string[] = [];
  const candidates: string[] = [];
  const review = { held: [] as ReviewedCandidateRef[], forced: [] as ReviewedCandidateRef[] };
  for (const { result } of outcomes) {
    if (result.error) errors.push(result.error);
    if (result.candidate) {
      candidates.push(result.candidate.id);
      review[result.candidate.mode].push(result.candidate.ref);
    }
  }
  const pages = outcomes.map(({ entry }) => entry);
  // Apply every live page as ONE journalled executor batch under the held lock,
  // then derive writtenPages from what ACTUALLY committed (skipped pages folded
  // into errors), so finalizeWiki never resolves/embeds an uncommitted page.
  const { writtenPages, batchErrors } = await commitLivePageWrites(root, outcomes);
  errors.push(...batchErrors);
  return { pages, writtenPages, errors, candidates, review, seedSlugs: [] };
}

/** One generated-page outcome paired with its source-order merged entry. */
interface GeneratedOutcome {
  entry: MergedConcept;
  result: MergedPageOutcome;
}

/**
 * Apply the live-write outcomes as ONE journalled executor batch, then return
 * the COMMITTED set (HIGH-A): the entries whose write committed become
 * `writtenPages`, while every floor-SKIPPED page is excluded and folded into
 * `batchErrors` (its `floor:` reason). Runs under compile's already-held lock,
 * so it uses the lock-free adapter core. An empty live set opens no batch.
 *
 * @param root - Project root the writes are confined under.
 * @param outcomes - Source-ordered generation outcomes.
 * @returns The committed entries plus any floor-skip errors.
 */
async function commitLivePageWrites(
  root: string,
  outcomes: GeneratedOutcome[],
): Promise<{ writtenPages: MergedConcept[]; batchErrors: string[] }> {
  const live = outcomes.filter((o) => o.result.liveWrite);
  const { skipped } = await applyCompilePageWritesLocked(
    root,
    live.map((o) => o.result.liveWrite!),
  );
  const skippedKeys = new Set(skipped.map((s) => `${s.item.namespace}/${s.item.slug}`));
  const writtenPages = live
    .filter((o) => !skippedKeys.has(`${o.result.liveWrite!.namespace}/${o.result.liveWrite!.slug}`))
    .map((o) => o.entry);
  const batchErrors = skipped.map(
    (s) => `Page "${s.item.slug}" skipped — ${s.reason}`,
  );
  return { writtenPages, batchErrors };
}

/** Persist source state for every extraction that produced concepts.
 *
 * State records only LIVE concepts per source — slugs that were actually
 * written to wiki/ this run. Held or rejected concepts are never recorded
 * as compiled; approval adds the approved slug via persistCandidateSourceStates.
 * A source whose concepts are all held records hash + empty concepts list.
 */
async function persistExtractionStates(
  draft: CompileStateDraft,
  extractions: ExtractionResult[],
  writtenPages: MergedConcept[],
  retained: ReadonlySet<string> = new Set(),
): Promise<void> {
  // Build a set of live slugs per source: slugs from writtenPages that list
  // this source as a contributor.
  const liveSlugsForSource = buildLiveSlugsForSource(writtenPages);
  for (const result of extractions) {
    if (result.concepts.length === 0) continue;
    const liveSlugs = new Set(liveSlugsForSource.get(result.sourceFile) ?? []);
    // A slug held for another attempt is still OWNED by the source that
    // extracted it. Recording only WRITTEN slugs drops that claim, and unlike a
    // review hold nothing re-adds it: the retry re-extracts whichever sources
    // still list the concept, so a survivor erased here never returns and the
    // page is rebuilt without its contribution.
    for (const concept of result.concepts) {
      const slug = slugify(concept.concept);
      if (retained.has(slug)) liveSlugs.add(slug);
    }
    await persistSourceStateFiltered(
      draft, result.sourcePath, result.sourceFile, result.concepts, liveSlugs,
    );
  }
}

/** Build a map from source filename to the slugs written live this run. */
function buildLiveSlugsForSource(writtenPages: MergedConcept[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const page of writtenPages) {
    for (const sourceFile of page.sourceFiles) {
      const existing = map.get(sourceFile) ?? [];
      existing.push(page.slug);
      map.set(sourceFile, existing);
    }
  }
  return map;
}

/** Persist source state, filtering concepts to only those in the live set. */
async function persistSourceStateFiltered(
  draft: CompileStateDraft,
  sourcePath: string,
  sourceFile: string,
  concepts: ReturnType<typeof parseConcepts>,
  liveSlugs: Set<string>,
): Promise<void> {
  const hash = await hashFile(sourcePath);
  const entry: SourceState = {
    hash,
    concepts: concepts.map((c) => slugify(c.concept)).filter((s) => liveSlugs.has(s)),
    compiledAt: new Date().toISOString(),
  };
  draft.setSource(sourceFile, entry);
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
 * Apply `options.changeFilter` to the full detected change set.
 * When no filter is provided, returns the original list unchanged.
 * Separating this keeps `runCompilePipeline` below the cyclomatic threshold.
 */
function applyChangeFilter(
  detected: SourceChange[],
  filter: CompileOptions["changeFilter"],
): SourceChange[] {
  return filter ? detected.filter(filter) : detected;
}

/**
 * Orphan and clear persisted frozen slugs that no source owns.
 * @returns True when the draft was mutated and must be flushed.
 */
async function reconcileOwnerlessFrozen(
  root: string,
  draft: CompileStateDraft,
  reconciliationSlugs: ReadonlySet<string>,
): Promise<boolean> {
  if (reconciliationSlugs.size === 0) return false;
  await orphanUnownedFrozenPages(root, draft, new Set(reconciliationSlugs));
  draft.setFrozen(new Set());
  return true;
}

/**
 * Generate seed pages unless `skipSeedPages` is set or we are in review mode.
 * Centralises both guard conditions so each call site in the pipeline is a
 * single unconditional statement instead of an inline if-block.
 */
async function maybeSeedPages(
  root: string,
  schema: SchemaConfig,
  generation: PageGenerationResult,
  options: CompileOptions,
): Promise<void> {
  if (!options.review && !options.skipSeedPages) {
    await generateSeedPages(root, schema, generation);
  }
}

/**
 * The SHARED seed→finalize routing both pipeline branches use, so the seed batch
 * (in {@link generateSeedPages}) and the resolution batch (in {@link finalizeWiki})
 * stay routed through the executor on BOTH the normal path AND the
 * no-source-changes early-return path. Extracting it prevents the early branch
 * from drifting back to a direct write. Pass `draft = null` for the early branch
 * (no state mutations to flush).
 */
async function seedThenFinalize(
  root: string,
  schema: SchemaConfig,
  generation: PageGenerationResult,
  options: CompileOptions,
  draft: CompileStateDraft | null,
): Promise<void> {
  await maybeSeedPages(root, schema, generation, options);
  await finalizeWiki(root, draft, generation.writtenPages, generation.seedSlugs, {
    scoped: options.changeFilter !== undefined,
    embeddings: options.embeddings !== false,
  });
}

/** Inner pipeline, runs under lock protection. Returns structured CompileResult. */
async function runCompilePipeline(
  root: string,
  options: CompileOptions,
): Promise<CompileResult> {
  const startMs = Date.now();
  const schema = await loadSchema(root);
  const reviewPolicy = await loadReviewPolicy(root);
  reportSchemaStatus(schema);
  // Single in-memory draft of state.json for the whole run. Every intra-compile
  // state read/write goes through it; the durable marker advances only at the
  // SINGLE flush after the resolution phase commits (see finalizeWiki below).
  const draft = await CompileStateDraft.load(root);
  const state = draft.read();
  const detected = await detectChanges(root, state);
  const changes = promoteForPromptModifiers(
    applyChangeFilter(detected, options.changeFilter),
    state,
  );
  await markUnchangedPendingSources(root, changes);
  augmentWithAffectedSources(changes, findAffectedSources(state, changes, detected));
  const reconciliationSlugs = findReconciliationSlugs(state, changes);

  const buckets = bucketChanges(changes);
  if (buckets.toCompile.length === 0 && buckets.deleted.length === 0) {
    output.status("✓", output.success("Nothing to compile — all sources up to date."));
    // Seed pages are cheap deterministic writes — always run them even when
    // no source files changed, so adding a seed page to schema.json takes
    // effect on the next compile without needing a source file edit.
    if (!options.review) {
      const hasOwnerlessFrozen = await reconcileOwnerlessFrozen(
        root, draft, reconciliationSlugs,
      );
      const emptyGeneration: PageGenerationResult = {
        pages: [],
        writtenPages: [],
        errors: [],
        candidates: [],
        review: { held: [], forced: [] },
        seedSlugs: [],
      };
      // Ownerless frozen reconciliation mutates the draft; otherwise null keeps
      // the no-change path from rewriting state unnecessarily.
      await seedThenFinalize(
        root,
        schema,
        emptyGeneration,
        options,
        hasOwnerlessFrozen ? draft : null,
      );
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
    await markDeletedAsOrphaned(root, buckets.deleted, draft);
  }

  // Only extraction failures in THIS run freeze a page. Deletion and persisted
  // freezes are reconciliation work: their surviving owners rebuild cleanly.
  const frozenSlugs = new Set<string>();

  // Resolve once so an invalid override warns a single time, then cap both the
  // extraction and page-generation fan-outs identically.
  const concurrency = resolveCompileConcurrency(options.concurrency);
  const extractions = await runExtractionPhases(root, buckets.toCompile, state, changes, concurrency);
  if (!options.review) {
    freezeFailedExtractions(draft, extractions, frozenSlugs);
    reportFrozenSlugs(frozenSlugs);
  }

  // Snapshot pages on disk before generation so the journal can tell which
  // produced pages are new (created) versus overwritten (updated).
  const existingIds = await listExistingPageIds(root);
  const generation = await generatePagesPhase(
    root,
    extractions,
    frozenSlugs,
    reconciliationSlugs,
    schema,
    options,
    reviewPolicy,
    concurrency,
  );

  if (!options.review) {
    const written = new Set(generation.writtenPages.map((entry) => entry.slug));
    const retained = new Set(
      [...reconciliationSlugs, ...frozenSlugs].filter((slug) => !written.has(slug)),
    );
    await persistExtractionStates(draft, extractions, generation.writtenPages, retained);
    const orphanCandidates = new Set([...reconciliationSlugs, ...frozenSlugs]);
    if (orphanCandidates.size > 0) {
      await orphanUnownedFrozenPages(root, draft, orphanCandidates);
    }
    persistFrozenSlugs(draft, frozenSlugs, extractions, {
      pending: reconciliationSlugs,
      replaced: written,
    });
    // Seed + resolution route through the SAME executor batches as the
    // no-source-changes branch (see seedThenFinalize). The draft flush is the
    // single durable state write, done inside finalizeWiki after resolution
    // commits.
    await seedThenFinalize(root, schema, generation, options, draft);
    await logCompile(root, buckets, generation, existingIds);
  }
  verbose(`compile finished in ${Date.now() - startMs} ms`);
  return summarizeCompile(buckets, generation, extractions, options);
}

/**
 * Treat unchanged pending-candidate sources as skipped to avoid LLM churn.
 *
 * A candidate only covers this run's work when it matches on BOTH counts: the
 * source bytes, and the prompt modifiers it was generated under. The bytes stay
 * identical across a modifier change while the candidate's wording goes stale,
 * so a hash-only test demotes the promotion made moments earlier and reports
 * "Nothing to compile" with a candidate nobody asked for still pending.
 *
 * The candidate's OWN digest is the comparison, not the project's. Review mode
 * never flushes state, so a project whose only compiles were `--review` has no
 * recorded digest at all — and comparing against that absent value would make
 * clearing a modifier look like no change, because "none selected" is exactly
 * what an absent digest means.
 */
async function markUnchangedPendingSources(root: string, changes: SourceChange[]): Promise<void> {
  const pending = await collectPendingSourceStates(root);
  if (pending.size === 0) return;
  const requested = promptModifiersDigest();
  for (const change of changes) {
    if (change.status !== "new" && change.status !== "changed") continue;
    const entry = pending.get(change.file);
    if (!entry || entry.modifiers !== requested) continue;
    const currentHash = await hashFile(path.join(root, SOURCES_DIR, change.file));
    if (currentHash === entry.hash) change.status = "unchanged";
  }
}

/**
 * Source hash + modifier snapshots currently held inside pending candidates.
 *
 * A candidate written before the digest was recorded reads as "none selected",
 * matching how an absent state digest is read.
 */
async function collectPendingSourceStates(
  root: string,
): Promise<Map<string, { hash: string; modifiers: string }>> {
  const states = new Map<string, { hash: string; modifiers: string }>();
  for (const candidate of await listCandidates(root)) {
    const modifiers = candidate.promptModifiers ?? "";
    for (const [source, entry] of Object.entries(candidate.sourceStates ?? {})) {
      states.set(source, { hash: entry.hash, modifiers });
    }
  }
  return states;
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
  draft: CompileStateDraft,
): Promise<void> {
  for (const del of deleted) {
    await markOrphaned(root, del.file, draft);
  }
}

/**
 * Behavioural switches for {@link finalizeWiki}, named rather than positional.
 *
 * They arrive as an object because they are same-typed booleans that each
 * INVERT a behaviour: as adjacent positional parameters, transposing two of
 * them type-checks silently and the compile does the opposite of what the
 * caller asked, on paths whose whole point is that they run less than the
 * default. One flag was tolerable; a second one arriving is the signal to name
 * them rather than to add a sixth parameter.
 */
interface FinalizeFlags {
  /**
   * Refresh the embedding store after the durable state write. `false` skips it
   * entirely, including the pending-embeddings drain, for a caller that keeps
   * its own semantic index.
   *
   * Not a prompt modifier: it changes what runs AFTER pages are written, never
   * what any prompt asks for, so it must not enter the modifier digest or
   * invalidate a page that is byte-identical under it.
   */
  embeddings?: boolean;
  /**
   * The run recompiled a SUBSET by design (`refresh --stale` supplies a
   * `changeFilter`), so it must not record the prompt-modifier selection as
   * true of the whole project — see the flush below.
   */
  scoped?: boolean;
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
  draft: CompileStateDraft | null,
  pages: MergedConcept[],
  seedSlugs: string[] = [],
  flags: FinalizeFlags = {},
): Promise<void> {
  const { scoped = false, embeddings = true } = flags;
  const conceptChangedSlugs = pages.map((entry) => entry.slug);
  const conceptNewSlugs = pages
    .filter((entry) => entry.concept.is_new)
    .map((entry) => entry.slug);
  const allChangedSlugs = [...conceptChangedSlugs, ...seedSlugs];
  const allNewSlugs = [...conceptNewSlugs, ...seedSlugs];

  if (allChangedSlugs.length > 0) {
    output.status("🔗", output.info("Resolving interlinks..."));
    // Compute + apply the resolution rewrites as ONE journalled batch. compile
    // holds the project lock for its whole pipeline → the lock-free seam.
    await resolveAndApplyLinks(root, allChangedSlugs, allNewSlugs);
  }

  // SINGLE durable state write of the whole compile: the buffered draft is
  // flushed ONLY here, after resolution has committed. A crash before this
  // re-runs the whole compile from the prior on-disk state (no half-marked
  // sources). The no-source-changes early-return path passes a null draft —
  // it has no state mutations, so there is nothing to flush.
  //
  // The modifier digest is recorded HERE rather than at load, so a compile that
  // crashes mid-run leaves the previous digest on disk and the re-run still sees
  // the difference. Recording it up front would mark the run as done under the
  // new modifiers before any page was written under them.
  //
  // A SCOPED run (`refresh --stale`, which supplies a changeFilter) recompiles a
  // subset by design, so it must not record the selection as true of the whole
  // project: the sources it filtered out still carry the previous wording, and
  // advancing the digest would retire the only signal that says so. Leaving the
  // old digest costs the pages it did refresh a second regeneration on the next
  // full compile, which is the safe direction to be wrong in.
  if (draft) {
    if (!scoped) draft.setPromptModifiers(promptModifiersDigest());
    await draft.flush(root);
  }

  await generateIndex(root);
  await generateMOC(root);
  if (embeddings) await safelyUpdateEmbeddings(root, allChangedSlugs);
}

/**
 * Refresh the embeddings store without failing compilation.
 * Semantic search is a non-critical enhancement — missing API keys or
 * transient provider errors should produce a warning, not a broken build.
 *
 * DURABLE source↔embeddings consistency with a PER-ID lifecycle: because
 * source-state is already flushed (sources marked current) by the time this runs
 * and failures are SWALLOWED, a skipped/crashed refresh would otherwise leave stale
 * embeddings that the next compile never revisits (no source change → no refresh).
 * To close that, the changed page-ids are UNIONED (preserving existing attempt
 * counts) with any prior-pending entries and recorded to a durable, root-confined
 * write-ahead marker BEFORE the attempt. AFTER the attempt the marker is reconciled
 * per-id rather than all-or-nothing:
 *  - SUCCESS → {@link settleAfterSuccess} clears only the ids the core actually
 *    embedded; an id it SKIPPED (transiently ineligible) is retained with an
 *    incremented attempt count, never cleared un-embedded.
 *  - FAILURE → {@link settleAfterFailure} increments attempts for the whole batch.
 * Either way, an id that fails {@link MAX_PENDING_EMBEDDING_ATTEMPTS} times is
 * QUARANTINED (dropped + a visible warning), so a poison id can neither loop forever
 * (re-billing the provider) nor wedge the all-or-nothing batch it shares.
 *
 * `finalizeWiki` calls this on EVERY non-review compile (including the
 * no-source-changes early branch), so prior-pending ids are drained — retried —
 * even on an otherwise no-op compile.
 *
 * Compile only ever writes concept-namespace pages, so changed slugs are
 * qualified under `concepts/`. The full per-id drain lifecycle lives in the
 * SHARED {@link refreshEmbeddingsDrainingPending} (also used by `review approve`);
 * this wrapper only maps slugs → qualified page-ids. Compile already holds the
 * project lock → the shared drain calls the reentrancy-safe Core (the
 * self-locking wrapper would deadlock here).
 */
async function safelyUpdateEmbeddings(root: string, changedSlugs: string[]): Promise<void> {
  const conceptsNamespace = path.basename(CONCEPTS_DIR);
  const changedPageIds = changedSlugs.map((slug) => qualifiedPageId(conceptsNamespace, slug));
  await refreshEmbeddingsDrainingPending(root, changedPageIds);
}
