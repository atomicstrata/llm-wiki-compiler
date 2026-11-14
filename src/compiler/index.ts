/**
 * Compilation orchestrator for the llmwiki knowledge compiler.
 *
 * Coordinates the full pipeline: lock acquisition, change detection,
 * concept extraction via LLM, wiki page generation with streaming output,
 * orphan marking for deleted sources, interlink resolution, and index
 * generation. Supports incremental compilation — only new or changed
 * sources are processed through the LLM pipeline.
 *
 * ONE BODY. {@link compileAndReport} runs {@link compileAndReportWith} over
 * {@link localCompileRunSteps}: ONE production orchestration body consumes
 * explicit steps. The production default supplies the local root forms
 * (each called at call time, so every namespace spy and module mock
 * intercepts). No non-disk production adapter exists; the bound composition is
 * test-only (`test/storage/compile-memory-steps.ts`). The acquisition reaches
 * the gate's four domain legs as
 * root-taking local steps (each delegates to one root-free decision body over
 * local-disk reads; see `lock-gate.ts`), and the provider, environment readers,
 * terminal output and `timeStage` stay host collaborators.
 */

import path from "path";
import { listDirectoryNames } from "../storage/disk-guarded-leaves.js";
import { CompileStateDraft } from "./compile-state-draft.js";
import {
  recoverJournalBeforeCompile,
  JournalUnsafeError,
} from "../trust/journal-recovery.js";
import type { SchemaConfig } from "../schema/index.js";
import { slugify } from "../utils/markdown.js";
import { releaseLock } from "../utils/lock.js";
import { acquireMutationLock } from "../operation-bundles/lock-gate.js";
import { parseConcepts } from "./prompts.js";
import { withRunNoPagesLimit, withRunSystemPolicy } from "./prompt-modifiers.js";
import {
  freezeFailedExtractions,
  findWithdrawnConcepts,
  persistFrozenSlugs,
  type ExtractionResult,
} from "./deps.js";
import { markOrphaned, orphanUnownedFrozenPages } from "./orphan.js";
import { applyCompilePageWritesLocked, type CompilePageWrite, type SkippedWrite } from "./compile-write.js";
import { diskCompileAccess, type CompileAccess } from "./compile-access.js";
import {
  emptyCompileResult,
  generatePagesPhase,
  prepareCompile,
  runReviewProposal,
  type CompilePreparation,
  type GeneratedOutcome,
} from "./compile-phases.js";
import * as output from "../utils/output.js";
import { verbose } from "../utils/output.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import { resolveCompileConcurrency } from "./concurrency.js";
import { runExtractionPhases } from "./extraction-phase.js";
import { withExtractionSnapshot } from "./extraction-snapshot.js";
import {
  finalizeUnchangedCompile, seedThenFinalize, type UnchangedCompilePreparation,
} from "./compile-finalize.js";
import {
  logCompile,
  printChangesSummary,
  reportFrozenSlugs,
  summarizeCompile,
} from "./compile-report.js";
import type { ChangeBuckets, MergedConcept, PageGenerationResult } from "./types.js";
import type {
  CompileOptions,
  CompileResult,
  SourceChange,
  SourceState,
} from "../utils/types.js";
import { timeStage } from "../utils/stage-timing.js";
import { runInSharedReadWindow } from "../utils/shared-read-window.js";

/**
 * Everything ONE compile run asks for, beyond the provider and the other host
 * collaborators. Each member is either the local ROOT form (the default) or
 * an accepted bound body (composed only in tests). Not `ProjectStore`, not a
 * backend, and it selects nothing.
 */
export interface CompileRunSteps {
  /** The ordinary gated acquisition: lock, the gate's own journal recovery, the four domain legs, each reached by root. Local: `acquireMutationLock(root, "ordinary")`. */
  acquire(root: string): Promise<boolean>;
  /** Local: `releaseLock(root)`. */
  release(root: string): Promise<void>;
  /** Compile's OWN strict replay-before-read (the second recovery of the run). Local: `recoverJournalBeforeCompile(root)`. */
  recoverJournal(root: string): ReturnType<typeof recoverJournalBeforeCompile>;
  /** The compile's content reads and records. Local: `diskCompileAccess(root)`; building it does no I/O. */
  access(root: string): CompileAccess;
  /** The run's single state draft. Local: `CompileStateDraft.load(root)`. */
  loadDraft(root: string): Promise<CompileStateDraft>;
  /** One journalled live page batch. Local: `applyCompilePageWritesLocked(root, items)`. */
  commitLive(root: string, items: CompilePageWrite[]): Promise<{ skipped: SkippedWrite[] }>;
  /** Orphan the pages a deleted source alone owned. Local: `markOrphaned(root, sourceFile, draft)`. */
  markOrphaned(root: string, sourceFile: string, draft: CompileStateDraft): Promise<void>;
  /** Orphan unowned frozen or reconciliation pages. Local: `orphanUnownedFrozenPages(root, draft, slugs)`. */
  orphanFrozen(root: string, draft: CompileStateDraft, slugs: Set<string>): Promise<void>;
  /** Seed, resolve, repair, flush, index, MOC, embeddings. Local: `seedThenFinalize(root, …)`. */
  seedThenFinalize(root: string, schema: SchemaConfig, generation: PageGenerationResult, options: CompileOptions, draft: CompileStateDraft): Promise<void>;
  /** The no-change route. Local: `finalizeUnchangedCompile(root, …)`. */
  finalizeUnchanged(root: string, draft: CompileStateDraft, prep: UnchangedCompilePreparation, options: CompileOptions): Promise<CompileResult>;
  /** One page namespace's names (rejects when it is absent). Local: `listDirectoryNames(path.join(root, dir))`. */
  listPageNames(root: string, dir: string): Promise<string[]>;
  /** Journal the run to `log.md` (warns, never throws). Local: `logCompile(root, …)`. */
  logCompile(root: string, buckets: ChangeBuckets, generation: PageGenerationResult, existingIds: Set<string>): Promise<void>;
}

/** LOCAL. The incumbent root forms for the project at `root`, each called at call time with its old arguments; frozen. In no package index. */
const localCompileRunSteps: CompileRunSteps = Object.freeze({
  acquire: (root: string) => acquireMutationLock(root, "ordinary"),
  release: (root: string) => releaseLock(root),
  recoverJournal: (root: string) => recoverJournalBeforeCompile(root),
  access: (root: string) => diskCompileAccess(root),
  loadDraft: (root: string) => CompileStateDraft.load(root),
  commitLive: (root: string, items: CompilePageWrite[]) => applyCompilePageWritesLocked(root, items),
  markOrphaned: (root: string, sourceFile: string, draft: CompileStateDraft) => markOrphaned(root, sourceFile, draft),
  orphanFrozen: (root: string, draft: CompileStateDraft, slugs: Set<string>) => orphanUnownedFrozenPages(root, draft, slugs),
  seedThenFinalize: (root: string, schema: SchemaConfig, generation: PageGenerationResult, options: CompileOptions, draft: CompileStateDraft) =>
    seedThenFinalize(root, schema, generation, options, draft),
  finalizeUnchanged: (root: string, draft: CompileStateDraft, prep: UnchangedCompilePreparation, options: CompileOptions) =>
    finalizeUnchangedCompile(root, draft, prep, options),
  listPageNames: (root: string, dir: string) => listDirectoryNames(path.join(root, dir)),
  logCompile: (root: string, buckets: ChangeBuckets, generation: PageGenerationResult, existingIds: Set<string>) =>
    logCompile(root, buckets, generation, existingIds),
});

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
  return runInSharedReadWindow(() => compileAndReportWith(localCompileRunSteps, root, options));
}

/**
 * {@link compileAndReport} over {@link CompileRunSteps}: THE ONE production
 * orchestration body. The production default supplies the local root forms;
 * no non-disk production adapter exists; the bound composition is test-only.
 *
 * @param steps - The gated acquisition, both recoveries, access, draft, page writes, orphans, finalize, listing and log.
 * @param root - Project root directory (a display and confinement value for the steps).
 * @param options - Optional pipeline overrides; `systemPolicy` is read once here and `review` once in the pipeline.
 * @returns Structured result describing what was compiled.
 */
export async function compileAndReportWith(
  steps: CompileRunSteps,
  root: string,
  options: CompileOptions = {},
): Promise<CompileResult> {
  output.header("llmwiki compile");

  const locked = await steps.acquire(root);
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
    const recovery = await steps.recoverJournal(root);
    if (recovery.status === "unsafe") {
      throw new JournalUnsafeError("pre-compile journal recovery unsafe");
    }
    // The policy is established for the WHOLE run, before change detection, so
    // the modifier digest it contributes is visible to the invalidation check
    // rather than only to the prompt builders further down.
    return await withRunSystemPolicy(options.systemPolicy, () =>
      withRunNoPagesLimit(options.noPagesLimit, () => runCompilePipeline(steps, root, options)),
    );
  } finally {
    await steps.release(root);
  }
}

/**
 * Apply the live-write outcomes as ONE journalled executor batch, then return
 * the COMMITTED set (HIGH-A): the entries whose write committed become
 * `writtenPages`, while every floor-SKIPPED page is excluded and folded into
 * `batchErrors` (its `floor:` reason). Runs under compile's already-held lock,
 * so it uses the lock-free adapter core. An empty live set opens no batch.
 *
 * @param steps - The run's steps (`commitLive` applies the batch).
 * @param root - Project root the writes are confined under.
 * @param outcomes - Source-ordered generation outcomes.
 * @returns The committed entries plus any floor-skip errors.
 */
async function commitLivePageWrites(
  steps: CompileRunSteps,
  root: string,
  outcomes: GeneratedOutcome[],
): Promise<{ writtenPages: MergedConcept[]; batchErrors: string[] }> {
  const live = outcomes.filter((o) => o.result.liveWrite);
  const { skipped } = await steps.commitLive(
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
  access: CompileAccess,
  draft: CompileStateDraft,
  extractions: ExtractionResult[],
  writtenPages: MergedConcept[],
  retained: ReadonlySet<string> = new Set(),
): Promise<void> {
  // Build a set of live slugs per source: slugs from writtenPages that list
  // this source as a contributor.
  const liveSlugsForSource = buildLiveSlugsForSource(writtenPages);
  for (const result of extractions) {
    // Reused contributors keep their complete committed ownership, including
    // concepts outside this run's page set and shared pages held for review.
    if (result.reused || result.failed) continue;
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
      draft, await access.hashSource(result.sourceFile), result.sourceFile, result.concepts, liveSlugs,
    );
    draft.setSource(result.sourceFile, withExtractionSnapshot(
      draft.read().sources[result.sourceFile], result, liveSlugsForSource.get(result.sourceFile),
    ));
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
  hash: string,
  sourceFile: string,
  concepts: ReturnType<typeof parseConcepts>,
  liveSlugs: Set<string>,
): Promise<void> {
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
async function listExistingPageIds(steps: CompileRunSteps, root: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const dir of [CONCEPTS_DIR, QUERIES_DIR]) {
    try {
      const files = await steps.listPageNames(root, dir);
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
 * Inner pipeline, runs under lock protection. Returns structured CompileResult.
 *
 * `--review` is the shared review-mode compile over this project's files. The
 * live compile shares its prefix and page generation with it and then does the
 * work that still writes through the root: batches, orphans, finalize.
 */
async function runCompilePipeline(
  steps: CompileRunSteps,
  root: string,
  options: CompileOptions,
): Promise<CompileResult> {
  const access = steps.access(root);
  if (options.review) return runReviewProposal(access, options);
  return runLiveCompile(steps, root, access, options);
}

/** One live run's prepared inputs, handed unchanged from the prepare half to the generate half. */
interface LiveRun extends Pick<CompilePreparation, "buckets" | "changes" | "reconciliationSlugs" | "schema" | "state"> {
  steps: CompileRunSteps;
  root: string;
  access: CompileAccess;
  options: CompileOptions;
  prep: CompilePreparation;
  draft: CompileStateDraft;
  startMs: number;
}

/** The live (non-review) compile: generate, write, and finalize under the lock. */
async function runLiveCompile(
  steps: CompileRunSteps,
  root: string,
  access: CompileAccess,
  options: CompileOptions,
): Promise<CompileResult> {
  const startMs = Date.now();
  // Single in-memory draft of state.json for the whole run. Every intra-compile
  // state read/write goes through it; the durable marker advances only at the
  // SINGLE flush after the resolution phase commits (see `compile-finalize.ts`).
  let draft!: CompileStateDraft;
  const prep = await prepareCompile(access, async () => {
    draft = await steps.loadDraft(root);
    return draft.read();
  }, options);
  const { buckets, changes, reconciliationSlugs, schema, state } = prep;
  if (buckets.toCompile.length === 0 && buckets.deleted.length === 0) {
    return steps.finalizeUnchanged(root, draft, prep, options);
  }

  printChangesSummary(changes);
  await markDeletedAsOrphaned(steps, root, buckets.deleted, draft);
  return generateAndFinalize({ steps, root, access, options, prep, draft, startMs, buckets, changes, reconciliationSlugs, schema, state });
}

/** The live compile's second half, in the incumbent order: extract, generate and commit, record state, orphan, finalize, log, report. */
async function generateAndFinalize(run: LiveRun): Promise<CompileResult> {
  const { steps, root, access, options, prep, draft, buckets, changes, schema, state } = run;
  // Only extraction failures in THIS run freeze a page. Deletion and persisted
  // freezes are reconciliation work: their surviving owners rebuild cleanly.
  const frozenSlugs = new Set<string>();

  // Resolve once so an invalid override warns a single time, then cap both the
  // extraction and page-generation fan-outs identically.
  const concurrency = resolveCompileConcurrency(options.concurrency);
  const extractions = await timeStage("compile.extraction", () => runExtractionPhases(
    access, buckets.toCompile, state,
    { scoped: changes, detected: prep.detected }, concurrency, prep.reusableSources,
  ));
  freezeFailedExtractions(draft, extractions, frozenSlugs);
  reportFrozenSlugs(frozenSlugs);

  // A successful --no-pages-limit extraction that drops a prior concept hands it to reconciliation.
  const reconciliationSlugs = new Set([...run.reconciliationSlugs, ...findWithdrawnConcepts(extractions)]);

  // Snapshot pages on disk before generation so the journal can tell which
  // produced pages are new (created) versus overwritten (updated).
  const existingIds = await listExistingPageIds(steps, root);
  const generation = await timeStage("compile.page-generation", () => generatePagesPhase({
    access, extractions, frozenSlugs, reconciliationSlugs, schema, options,
    policy: prep.reviewPolicy, concurrency,
    commitLive: (outcomes) => commitLivePageWrites(steps, root, outcomes),
  }));

  const written = new Set(generation.writtenPages.map((entry) => entry.slug));
  const retained = new Set(
    [...reconciliationSlugs, ...frozenSlugs].filter((slug) => !written.has(slug)),
  );
  await persistExtractionStates(access, draft, extractions, generation.writtenPages, retained);
  const orphanCandidates = new Set([...reconciliationSlugs, ...frozenSlugs]);
  if (orphanCandidates.size > 0) {
    await steps.orphanFrozen(root, draft, orphanCandidates);
  }
  persistFrozenSlugs(draft, frozenSlugs, extractions, {
    pending: reconciliationSlugs,
    replaced: written,
  });
  // Seed + resolution route through the SAME executor batches as the
  // no-source-changes branch (see seedThenFinalize). The draft flush is the
  // single durable state write, done in `compile-finalize.ts` after resolution
  // commits.
  await timeStage("compile.finalize", () => steps.seedThenFinalize(root, schema, generation, options, draft));
  await steps.logCompile(root, buckets, generation, existingIds);
  verbose(`compile finished in ${Date.now() - run.startMs} ms`);
  return summarizeCompile(buckets, generation, extractions, options);
}

/** Mark wiki pages owned solely by deleted sources as orphaned. */
async function markDeletedAsOrphaned(
  steps: CompileRunSteps,
  root: string,
  deleted: SourceChange[],
  draft: CompileStateDraft,
): Promise<void> {
  for (const del of deleted) {
    await steps.markOrphaned(root, del.file, draft);
  }
}
