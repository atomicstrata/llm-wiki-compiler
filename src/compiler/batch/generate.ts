/**
 * @file src/compiler/batch/generate.ts
 * @description The GENERATE phase of a batch compile: one page per planned
 * slug (`go:<n>`), in the incumbent merge order, a checkpointed batch at a
 * time.
 *
 * MERGE. A page's contributions come from the contribution index in
 * incumbent order (extraction, then concept); the first one's concept is the
 * page's, each later one is folded in by the incumbent
 * `reconcileConceptMetadata`, every contribution names its source in
 * `sourceFiles` and adds its source text as a slice, and the incumbent
 * `buildBudgetedCombinedContent` budgets them. A reconciliation slug is a
 * clean rebuild. Each contribution's source is re-read (bounded) and must
 * still hash to what was extracted. EVERY concept is generated once per run,
 * from all its contributions, however many batches its sources spanned.
 *
 * GENERATION. The incumbent `generateMergedPage` (render, lint, policy,
 * validation), with the run's link targets and the batch access; a batch
 * shares one `pLimit(concurrency)` that stops at the first hard failure and
 * drains what it admitted. Live writes are committed through the
 * byte-bounded journalled batcher. Each page's outcome is `gr:<slug>`:
 * written or not, its error, whether its concept is new, and whether its page
 * existed before. A crash redoes the batch from the last checkpoint.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import pLimit from "p-limit";
import type { ReviewPolicy } from "../../review/policy.js";
import type { SchemaConfig } from "../../schema/index.js";
import { CONCEPTS_DIR } from "../../utils/constants.js";
import type { CompileOptions } from "../../utils/types.js";
import type { CompileAccess } from "../compile-access.js";
import { reconcileConceptMetadata } from "../extraction-merge.js";
import { buildBudgetedCombinedContent, type SourceSlice } from "../prompt-budget.js";
import { runLimitedUntilFailure } from "../limited-until-failure.js";
import { generateMergedPage } from "../review-pipeline.js";
import type { MergedConcept, MergedPageOutcome } from "../types.js";
import { BatchCompileError, contributionsPrefix, keySeq, parseContributionKey, seqKey } from "./contracts.js";
import type { ExtractionRowV1 } from "./extract.js";
import type { PlannedPageV1 } from "./generation-plan.js";
import { PageWriteBatcher } from "./page-writes.js";
import { intentKey, pageDigest } from "./inherit.js";
import { report } from "./report.js";
import type { BatchRun } from "./run-store.js";
import { readSourceBounded } from "./sources.js";

/**
 * Most pages one generation batch holds, whatever the configured batch size:
 * each page's merged input is within the fan-in byte cap and its body within
 * the page cap, so a batch holds at most this many of each.
 */
const MAX_GENERATE_BATCH = 8;

/** A page's generation outcome. */
export interface GeneratedPageV1 {
  readonly written: boolean;
  readonly error?: string;
  /** The page's concept is new (inbound links are resolved to it). */
  readonly isNew: boolean;
  /** A page existed at its path before this run generated it. */
  readonly existed: boolean;
}

/** What one generation phase works over. */
export interface GenerateContext {
  readonly run: BatchRun;
  readonly access: CompileAccess;
  readonly schema: SchemaConfig;
  readonly policy: ReviewPolicy;
  readonly options: CompileOptions;
  readonly concurrency: number;
}

/** One contribution's source text, re-read and checked against what was extracted. */
async function contributionText(run: BatchRun, extraction: ExtractionRowV1): Promise<string> {
  const read = await readSourceBounded(run.root, extraction.file);
  if (read.hash !== extraction.hash) throw new BatchCompileError("compile_batch_inputs_changed", `source ${extraction.file.slice(0, 80)} changed after it was extracted; re-run the compile`);
  return read.text;
}

/** Whether `slug` rebuilds without its old page: a reconciliation slug. */
async function cleanRebuild(run: BatchRun, slug: string): Promise<boolean> {
  return (await run.get(`rs:${slug}`)) !== undefined;
}

/** The merged concept of `slug`: every contribution in incumbent order. */
async function mergedConcept(run: BatchRun, slug: string, linkTargets: readonly string[]): Promise<MergedConcept> {
  let entry: MergedConcept | undefined;
  const slices: SourceSlice[] = [];
  for await (const row of run.scan(contributionsPrefix(slug))) {
    const { seq, idx } = parseContributionKey(row.k);
    const extraction = (await run.get(seqKey("x:", seq))) as ExtractionRowV1;
    const concept = extraction.concepts[idx]!;
    if (entry === undefined) {
      entry = { slug, concept, sourceFiles: [extraction.file], combinedContent: "", ...((await cleanRebuild(run, slug)) ? { rebuild: true } : {}) };
    } else {
      entry.concept = reconcileConceptMetadata(entry.concept, concept);
      entry.sourceFiles.push(extraction.file);
    }
    slices.push({ file: extraction.file, content: await contributionText(run, extraction) });
  }
  if (entry === undefined) throw new BatchCompileError("compile_batch_inputs_changed", `page ${slug.slice(0, 80)} lost its contributions`);
  return { ...entry, combinedContent: buildBudgetedCombinedContent(entry.concept.concept, slices), linkTargets };
}

/** Generate one page and decide its outcome (the write itself is batched). */
async function generateOne(context: GenerateContext, slug: string, linkTargets: readonly string[]): Promise<{ slug: string; entry: MergedConcept; outcome: MergedPageOutcome; existed: boolean }> {
  const entry = await mergedConcept(context.run, slug, linkTargets);
  const existed = existsSync(path.join(context.run.root, CONCEPTS_DIR, `${slug}.md`));
  return { slug, entry, outcome: await generateMergedPage(context.access, entry, context.schema, context.options, {}, context.policy), existed };
}

/** One generated page of a batch. */
type GeneratedResult = Awaited<ReturnType<typeof generateOne>>;
/** What a batch's publication did: the slugs written, and the floor-skip reason of each skipped one. */
interface Published { readonly written: Set<string>; readonly skipped: Map<string, string> }

/** Durably record every live write's intent, then publish them in byte-bounded journalled batches. */
async function publish(run: BatchRun, results: readonly GeneratedResult[]): Promise<Published> {
  const published: Published = { written: new Set(), skipped: new Map() };
  const batcher = new PageWriteBatcher(run.root, async (applied, floor) => {
    for (const write of applied) published.written.add(write.slug);
    for (const item of floor) published.skipped.set(item.item.slug, `Page "${item.item.slug}" skipped — ${item.reason}`);
  });
  const live = results.flatMap((result) => (result.outcome.liveWrite ? [result.outcome.liveWrite] : []));
  // Durable intent BEFORE publication: a restart after a kill here still knows these pages may be live (`./inherit.ts`).
  for (const write of live) await run.put(intentKey(write.slug, pageDigest(write.body)), 1);
  await run.persist();
  for (const write of live) await batcher.add(write);
  await batcher.flush();
  return published;
}

/** Record one generated page's outcome, counters and report lines. */
async function recordOutcome(run: BatchRun, result: GeneratedResult, published: Published): Promise<void> {
  const error = result.outcome.error ?? published.skipped.get(result.slug);
  const outcome: GeneratedPageV1 = { written: published.written.has(result.slug), isNew: result.entry.concept.is_new, existed: result.existed, ...(error === undefined ? {} : { error }) };
  await run.put(`gr:${result.slug}`, outcome);
  if (outcome.written) { run.counters.pagesWritten += 1; await report(run, { kind: "page", slug: result.slug, created: !result.existed }); }
  if (error !== undefined) { run.counters.pageErrors += 1; await report(run, { kind: "error", slug: result.slug, message: error }); }
}

/**
 * Generate and commit one batch of planned pages. A hard page failure stops
 * admission and escapes with the original error only after the batch's
 * in-flight pages settle, before any intent, publication or checkpoint.
 */
async function generateBatch(context: GenerateContext, pages: PlannedPageV1[], linkTargets: readonly string[]): Promise<void> {
  const results = await runLimitedUntilFailure(pLimit(context.concurrency), pages, (page) => generateOne(context, page.slug, linkTargets));
  const published = await publish(context.run, results);
  for (const result of results) await recordOutcome(context.run, result, published);
}

/** The generate phase, resumable after the last batch it finished. */
export async function runGeneration(context: GenerateContext): Promise<void> {
  const { run } = context;
  const linkTargets = ((await run.get("lt")) as string[] | undefined) ?? [];
  let batch: PlannedPageV1[] = [];
  let last = (run.meta.cursor.after as number | undefined) ?? -1;
  const size = Math.min(run.meta.batchSize, MAX_GENERATE_BATCH);
  for await (const row of run.scan("go:", seqKey("go:", last + 1))) {
    batch.push(row.v as PlannedPageV1);
    last = keySeq("go:", row.k);
    if (batch.length < size) continue;
    await generateBatch(context, batch, linkTargets);
    await run.checkpoint({ cursor: { after: last } });
    batch = [];
  }
  if (batch.length > 0) { await generateBatch(context, batch, linkTargets); await run.checkpoint({ cursor: { after: last } }); }
  await run.advance("plan-state", { after: -1 });
}
