/**
 * Presentation and logging for the compilation pipeline.
 *
 * Owns the single responsibility of REPORTING what a compile did — emitting the
 * CLI banners/status lines, journalling the run to `log.md`, and building the
 * structured {@link CompileResult} — without mutating any content pages on disk.
 * Every function here is pure presentation or append-only activity logging; the
 * orchestration spine in `index.ts` owns the page-mutating work.
 */

import { appendLog, formatList, formatWikilinkList } from "../utils/activity-log.js";
import * as output from "../utils/output.js";
import { CONCEPTS_DIR } from "../utils/constants.js";
import type { SchemaConfig } from "../schema/index.js";
import type { ExtractionResult } from "./deps.js";
import type {
  CompileOptions,
  CompileResult,
  SourceChange,
} from "../utils/types.js";
import type { ChangeBuckets, PageGenerationResult } from "./types.js";

/**
 * Journal a non-review compile to log.md: the source files consumed, plus the
 * produced pages split into created (new on disk) and updated (overwritten).
 * Compile only ever writes concept-namespace pages (concept and seed pages both
 * land under wiki/concepts/), so existence is checked against that namespace.
 */
export async function logCompile(
  root: string,
  buckets: ChangeBuckets,
  generation: PageGenerationResult,
  existingIds: Set<string>,
): Promise<void> {
  if (buckets.toCompile.length === 0 && buckets.deleted.length === 0) return;
  const produced = [...new Set([...generation.writtenPages.map((entry) => entry.slug), ...generation.seedSlugs])];
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
export function summarizeCompile(
  buckets: ChangeBuckets,
  generation: PageGenerationResult,
  extractions: ExtractionResult[],
  options: CompileOptions,
): CompileResult {
  output.header("Compilation complete");
  output.status("✓", output.success(
    `${buckets.toCompile.length} compiled, ${buckets.unchanged.length} skipped, ${buckets.deleted.length} deleted`,
  ));
  if (generation.candidates.length > 0) {
    output.status("?", output.info(
      reviewSummaryLine(generation),
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
  const conceptSlugs = generation.writtenPages.map((entry) => entry.slug);
  const baseResult: CompileResult = {
    compiled: buckets.toCompile.length,
    skipped: buckets.unchanged.length,
    deleted: buckets.deleted.length,
    concepts: generation.pages.map((entry) => entry.concept.concept),
    pages: [...conceptSlugs, ...generation.seedSlugs],
    errors,
  };
  if (generation.candidates.length > 0) {
    baseResult.candidates = generation.candidates;
    baseResult.review = generation.review;
  }
  return baseResult;
}

/** Human completion line for candidates created this run. */
function reviewSummaryLine(generation: PageGenerationResult): string {
  const held = generation.review.held.length;
  const forced = generation.review.forced.length;
  if (held > 0 && forced === 0) {
    return `Wrote ${generation.writtenPages.length} page(s), held ${held} for review — run \`llmwiki review list\``;
  }
  return `${generation.candidates.length} candidate(s) awaiting review — run \`llmwiki review list\``;
}

/** Print a summary of detected source file changes. */
export function printChangesSummary(changes: SourceChange[]): void {
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

/** Log where the schema was loaded from so the user can confirm it was picked up. */
export function reportSchemaStatus(schema: SchemaConfig): void {
  if (schema.loadedFrom) {
    output.status("i", output.dim(`Schema: ${schema.loadedFrom}`));
  }
}

/** Log frozen slugs (shared concepts whose deletion-pinned content must persist). */
export function reportFrozenSlugs(frozenSlugs: Set<string>): void {
  for (const slug of frozenSlugs) {
    output.status("i", output.dim(`Frozen: ${slug} (shared with deleted source)`));
  }
}
