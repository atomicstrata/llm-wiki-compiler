/**
 * Programmatic incremental compile delta (incremental delta).
 *
 * Exposes {@link compileDelta}: a library entry point that runs the normal
 * hash-gated compile and then returns ONLY the export pages that changed in
 * that run, instead of the full corpus. A caller (e.g. a downstream rule importer) can
 * poll this after each ingest and ship just the deltas to its downstream
 * store, without diffing the whole wiki itself.
 *
 * The change set is driven entirely by the compiler's existing
 * SHA-256-over-source change detection (`detectChanges` / `.llmwiki/state.json`
 * via `src/compiler/hasher.ts`). `compileAndReport` already returns the slugs
 * it (re)wrote this run on `CompileResult.pages`; we intersect those with the
 * freshly-collected export pages so the delta carries the same enriched,
 * provenance-stamped {@link ExportPage} shape the full JSON export emits.
 *
 * When nothing changed since the persisted state, `CompileResult.pages` is
 * empty and the returned delta is empty too — the "unchanged ⇒ empty delta"
 * contract the W5 test pins.
 *
 * A project whose segmented compile state is the authority compiles through
 * the bounded batch body, whose result lists no pages (and whose delta would
 * hold the whole corpus in memory), so `compileDelta` refuses there BEFORE
 * compiling (`compile_batch_unsupported_option`); page the run's report instead.
 */

import { compileStateSegmented } from "../cstate/records.js";
import { BatchCompileError } from "./batch/contracts.js";
import { compileAndReport } from "./index.js";
import { collectExportPages } from "../export/collect.js";
import type { ExportPage } from "../export/types.js";
import type { CompileOptions, ReviewedCandidateRef } from "../utils/types.js";

/** Options for {@link compileDelta}. Pass-through to the compile pipeline. */
export type CompileDeltaOptions = CompileOptions;

/** Result of an incremental delta compile. */
export interface CompileDeltaResult {
  /**
   * Export pages that changed in this run — new or recompiled. Carries the
   * full {@link ExportPage} shape (provenance hashes included) so the caller
   * can persist deltas through the same contract as a full export.
   */
  changedPages: ExportPage[];
  /** Slugs of the changed pages, in collection (title-sorted) order. */
  changedSlugs: string[];
  /** Count of sources (re)compiled this run. */
  compiled: number;
  /** Count of unchanged sources skipped this run. */
  skipped: number;
  /** Count of sources whose pages were orphaned by deletion this run. */
  deleted: number;
  /** Non-fatal errors collected during the compile. */
  errors: string[];
  /**
   * Count of pages held for review this run (policy-held or forced by --review).
   * Zero when no policy is active or no pages were held. Present so callers can
   * distinguish "empty delta because nothing changed" from "empty delta because
   * everything was held for review".
   */
  held: number;
  /**
   * Structured refs for pages held for review this run. Empty when held is 0.
   * Carries id, slug, and the reason codes that triggered the hold.
   */
  heldCandidates: ReviewedCandidateRef[];
}

/**
 * Run an incremental compile and return only the pages that changed.
 *
 * Reuses the compiler's hash-gated change detection: sources whose SHA-256
 * matches the persisted `.llmwiki/state.json` entry are skipped, so a second
 * call with an up-to-date state yields an empty `changedPages`. Adding or
 * editing a source yields exactly that source's page(s) in the delta.
 *
 * @param root - Project root directory.
 * @param options - Optional pipeline overrides (forwarded to compile).
 * @returns The changed export pages plus run counts.
 */
export async function compileDelta(
  root: string,
  options: CompileDeltaOptions = {},
): Promise<CompileDeltaResult> {
  if (await compileStateSegmented(root)) {
    throw new BatchCompileError("compile_batch_unsupported_option", "compileDelta is not available on a segmented project; run compile() and page compileReport(runId) instead");
  }
  const result = await compileAndReport(root, options);
  const changedSlugSet = new Set(result.pages);

  // `result.pages` are concept/seed slugs, all written under wiki/concepts.
  // Match on (pageDirectory, slug), not bare slug, so a saved query that
  // happens to share a slug with a changed concept is never mis-included.
  const allPages = await collectExportPages(root);
  const changedPages = allPages.filter(
    (page) => page.pageDirectory === "concepts" && changedSlugSet.has(page.slug),
  );

  const heldCandidates = [
    ...(result.review?.held ?? []),
    ...(result.review?.forced ?? []),
  ];
  return {
    changedPages,
    changedSlugs: changedPages.map((page) => page.slug),
    compiled: result.compiled,
    skipped: result.skipped,
    deleted: result.deleted,
    errors: result.errors,
    held: heldCandidates.length,
    heldCandidates,
  };
}
