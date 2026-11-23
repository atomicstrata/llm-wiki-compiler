/**
 * @file src/compiler/compile-phases.ts
 * @description The compile phases that are the same work wherever a project
 * lives: deciding what changed, extracting concepts, and generating pages.
 *
 * These phases read a project only through {@link CompileAccess}, so they run
 * over a local directory and over a host-owned store alike. The orchestrator in
 * `compiler/index.ts` holds the project lock and owns everything that still
 * writes through a root path (live page batches, orphan marking, finalize); it
 * calls into here for the shared prefix and for page generation.
 *
 * {@link runReviewProposal} is the whole review-mode compile: it produces
 * candidates and mutates no wiki page and no compile state. The local
 * `compile --review` runs it, and so does a portable host — there is one
 * review-mode compile, not a second pipeline written for another backend.
 */

import pLimit from "p-limit";
import type { CompileAccess } from "./compile-access.js";
import {
  promoteForPromptModifiers,
  promptModifiersDigest,
} from "./prompt-modifiers.js";
import {
  findAffectedSources,
  findReconciliationSlugs,
  findWithdrawnConcepts,
  type ExtractionResult,
} from "./deps.js";
import { buildExtractionSourceStates } from "./source-state.js";
import { resolveCompileConcurrency } from "./concurrency.js";
import { runLimitedUntilFailure } from "./limited-until-failure.js";
import { mergeExtractions } from "./extraction-merge.js";
import { buildLinkTargets } from "./link-targets.js";
import { runExtractionPhases } from "./extraction-phase.js";
import { reusableSourceFiles } from "./extraction-snapshot.js";
import { generateMergedPage } from "./review-pipeline.js";
import { printChangesSummary, reportSchemaStatus, summarizeCompile } from "./compile-report.js";
import { isPolicyOff } from "../review/policy.js";
import type { ReviewPolicy } from "../review/policy.js";
import type { SchemaConfig } from "../schema/index.js";
import * as output from "../utils/output.js";
import { verbose } from "../utils/output.js";
import { timeStage } from "../utils/stage-timing.js";
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
  WikiState,
} from "../utils/types.js";

/** Empty CompileResult used when no pipeline work runs (e.g. lock contention). */
export function emptyCompileResult(): CompileResult {
  return { compiled: 0, skipped: 0, deleted: 0, concepts: [], pages: [], errors: [] };
}

/** Sort source changes into the buckets the pipeline acts on. */
function bucketChanges(changes: SourceChange[]): ChangeBuckets {
  return {
    toCompile: changes.filter((c) => c.status === "new" || c.status === "changed"),
    deleted: changes.filter((c) => c.status === "deleted"),
    unchanged: changes.filter((c) => c.status === "unchanged"),
  };
}

/**
 * Apply `options.changeFilter` to the full detected change set.
 * When no filter is provided, returns the original list unchanged.
 */
function applyChangeFilter(
  detected: SourceChange[],
  filter: CompileOptions["changeFilter"],
): SourceChange[] {
  return filter ? detected.filter(filter) : detected;
}

/** Append affected-source changes (logging each addition) to the change list. */
function augmentWithAffectedSources(changes: SourceChange[], affected: string[]): void {
  for (const file of affected) {
    output.status("~", output.info(`${file} [affected by shared concept]`));
    changes.push({ file, status: "changed" });
  }
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
async function markUnchangedPendingSources(access: CompileAccess, changes: SourceChange[]): Promise<void> {
  const pending = await access.pendingSourceStates();
  if (pending.size === 0) return;
  const requested = promptModifiersDigest();
  for (const change of changes) {
    if (change.status !== "new" && change.status !== "changed") continue;
    const entry = pending.get(change.file);
    if (!entry || entry.modifiers !== requested) continue;
    const currentHash = await access.hashSource(change.file);
    if (currentHash === entry.hash) change.status = "unchanged";
  }
}

/** What a compile has decided to act on, before any model call. */
export interface CompilePreparation {
  schema: SchemaConfig;
  reviewPolicy: ReviewPolicy;
  /** The compile state the run started from. */
  state: WikiState;
  /** Everything found, before any `changeFilter`. */
  detected: SourceChange[];
  /** What this run acts on. */
  changes: SourceChange[];
  reusableSources: ReadonlySet<string>;
  reconciliationSlugs: ReadonlySet<string>;
  buckets: ChangeBuckets;
}

/**
 * The shared prefix of every compile: load schema and policy, detect changes
 * against the starting state, and settle the set of sources this run acts on.
 *
 * @param access - The project's access seam.
 * @param loadState - Loads the compile state the run starts from. Called after
 *   the schema is reported, which is the order a local compile has always used.
 * @param options - Pipeline overrides.
 * @returns The schema, policy and change sets the later phases use.
 */
export async function prepareCompile(
  access: CompileAccess,
  loadState: () => Promise<WikiState>,
  options: CompileOptions,
): Promise<CompilePreparation> {
  const schema = await access.loadSchema();
  const reviewPolicy = await access.loadReviewPolicy();
  reportSchemaStatus(schema);
  const state = await loadState();
  const detected = await timeStage("compile.detect-changes", () => access.detectChanges(state));
  const changes = promoteForPromptModifiers(
    applyChangeFilter(detected, options.changeFilter),
    state,
  );
  await markUnchangedPendingSources(access, changes);
  const reusableSources = reusableSourceFiles(state, changes, detected, Boolean(options.review));
  augmentWithAffectedSources(changes, findAffectedSources(state, changes, detected));
  const reconciliationSlugs = findReconciliationSlugs(state, changes);
  return {
    schema, reviewPolicy, state, detected, changes, reusableSources, reconciliationSlugs,
    buckets: bucketChanges(changes),
  };
}

/** One generated-page outcome paired with its source-order merged entry. */
export interface GeneratedOutcome {
  entry: MergedConcept;
  result: MergedPageOutcome;
}

/** Commits the live-write outcomes and reports which entries landed. */
export type CommitLiveWrites = (
  outcomes: GeneratedOutcome[],
) => Promise<{ writtenPages: MergedConcept[]; batchErrors: string[] }>;

/** Inputs to {@link generatePagesPhase}, named because several are same-typed. */
export interface PageGenerationInput {
  access: CompileAccess;
  extractions: ExtractionResult[];
  frozenSlugs: Set<string>;
  reconciliationSlugs: ReadonlySet<string>;
  schema: SchemaConfig;
  options: CompileOptions;
  policy: ReviewPolicy;
  concurrency: number;
  /** How live writes are committed; a review-mode run has none to commit. */
  commitLive: CommitLiveWrites;
}

/** A review-mode run generates candidates only, so nothing is written live. */
const noLiveWrites: CommitLiveWrites = async () => ({ writtenPages: [], batchErrors: [] });

/** Phase 2: generate pages for merged concepts in parallel, capturing errors. */
export async function generatePagesPhase(input: PageGenerationInput): Promise<PageGenerationResult> {
  const { access, extractions, schema, options, policy } = input;
  const concepts = mergeExtractions(extractions, input.frozenSlugs, input.reconciliationSlugs);
  const linkTargets = await buildLinkTargets(access, concepts);
  const merged = concepts.map((entry) => ({ ...entry, linkTargets }));
  // Build the per-source state snapshot once so each candidate can carry the
  // exact data needed to mark its sources compiled on approval.
  const shouldBuildSourceStates = options.review || !isPolicyOff(policy);
  const sourceStates = shouldBuildSourceStates
    ? await buildExtractionSourceStates(access, extractions)
    : {};
  // Collect per-outcome errors and candidate info AFTER every page settles, then
  // derive candidates/review by iterating outcomes in source order. A fatal page
  // failure stops admission and rejects here, after in-flight pages settle and
  // before any live commit.
  const outcomes: GeneratedOutcome[] = await runLimitedUntilFailure(
    pLimit(input.concurrency),
    merged,
    async (entry) => ({ entry, result: await generateMergedPage(access, entry, schema, options, sourceStates, policy) }),
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
  const { writtenPages, batchErrors } = await input.commitLive(outcomes);
  errors.push(...batchErrors);
  return { pages, writtenPages, errors, candidates, review, seedSlugs: [] };
}

/**
 * The review-mode compile: extract, generate, and emit every page as a
 * candidate through the access seam. It writes no wiki page and no compile
 * state — deletion bookkeeping and source-state persistence are deferred to a
 * later pass, exactly as `compile --review` has always behaved.
 *
 * @param access - The project's access seam; candidates go to its sink.
 * @param options - Pipeline overrides; `review` is forced on.
 * @returns The structured compile result naming the candidates produced.
 */
export async function runReviewProposal(
  access: CompileAccess,
  options: CompileOptions,
): Promise<CompileResult> {
  const startMs = Date.now();
  const reviewOptions = { ...options, review: true };
  const prep = await prepareCompile(access, () => access.readState(), reviewOptions);
  const { buckets, state } = prep;
  if (buckets.toCompile.length === 0 && buckets.deleted.length === 0) {
    output.status("✓", output.success("Nothing to compile — all sources up to date."));
    return { ...emptyCompileResult(), skipped: buckets.unchanged.length };
  }
  printChangesSummary(prep.changes);
  const concurrency = resolveCompileConcurrency(reviewOptions.concurrency);
  const extractions = await timeStage("compile.extraction", () => runExtractionPhases(
    access, buckets.toCompile, state,
    { scoped: prep.changes, detected: prep.detected }, concurrency, prep.reusableSources,
  ));
  const generation = await timeStage("compile.page-generation", () => generatePagesPhase({
    access, extractions, frozenSlugs: new Set<string>(),
    reconciliationSlugs: new Set([...prep.reconciliationSlugs, ...findWithdrawnConcepts(extractions)]), schema: prep.schema,
    options: reviewOptions, policy: prep.reviewPolicy, concurrency, commitLive: noLiveWrites,
  }));
  verbose(`compile finished in ${Date.now() - startMs} ms`);
  return summarizeCompile(buckets, generation, extractions, reviewOptions);
}
