/**
 * @file src/compiler/batch/seeds.ts
 * @description The SEEDS phase of a batch compile: the incumbent seed body
 * (`generateSeedPagesWith`: schema-declared overview, comparison and entity
 * pages, first-wins deduplication, every seed generated before the seed batch
 * is published), after every concept page and BEFORE resolution and repair,
 * exactly as the incumbent tail orders them.
 *
 * BOUNDED. The seed configuration is checked before the run's first effect
 * ({@link assertSeedsBounded}: at most {@link MAX_SEED_PAGES} seeds, each with
 * at most {@link MAX_SEED_RELATED} related pages), and every page the body
 * reads goes through the bounded page read, and every generated seed page is
 * checked against the page cap BEFORE the seed batch is published, so the one
 * seed batch holds at most that many pages, each within the page cap (the
 * provider's output-token limit bounds each completion before that).
 *
 * Each committed seed slug is `sd:<slug>` (`created` when no page was at its
 * path before) and reported; a seed error is reported. A crash redoes the phase.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { SchemaConfig } from "../../schema/index.js";
import { CONCEPTS_DIR } from "../../utils/constants.js";
import { callClaude } from "../../utils/llm.js";
import { slugify } from "../../utils/markdown.js";
import { applyCompilePageWritesLocked, type CompilePageWrite } from "../compile-write.js";
import { generateSeedPagesWith, type SeedPageSteps } from "../seed-pages.js";
import type { PageGenerationResult } from "../types.js";
import { BatchCompileError } from "./contracts.js";
import { MAX_PAGE_BYTES, pageContentBounded } from "./pages.js";
import { report } from "./report.js";
import type { BatchRun } from "./run-store.js";

/** Most seed pages a batch compile generates. */
const MAX_SEED_PAGES = 32;
/** Most related pages one seed reads. */
const MAX_SEED_RELATED = 16;

/** Refuse, before the seed batch is published, any seed page above the batch page cap (it could never be read back). */
function assertSeedPagesBounded(writes: readonly CompilePageWrite[]): void {
  const over = writes.find((write) => Buffer.byteLength(write.body) > MAX_PAGE_BYTES);
  if (over !== undefined) throw new BatchCompileError("compile_batch_page_too_large", `seed page ${over.slug.slice(0, 80)} is ${Buffer.byteLength(over.body)} bytes, over the ${MAX_PAGE_BYTES}-byte batch page cap; nothing of the seed batch was written`);
}

/** The incumbent seed steps, with every page read bounded and every page written within the page cap. */
const BOUNDED_SEED_STEPS: SeedPageSteps = {
  complete: (request) => callClaude(request),
  readPage: (root, relDir, slug) => pageContentBounded(root, relDir, slug),
  writePages: (root, writes) => {
    assertSeedPagesBounded(writes);
    return applyCompilePageWritesLocked(root, writes);
  },
};

/** Refuse (before any effect) a seed configuration the batch route cannot generate within its bounds. */
export function assertSeedsBounded(schema: SchemaConfig): void {
  const related = Math.max(0, ...schema.seedPages.map((seed) => seed.relatedSlugs?.length ?? 0));
  if (schema.seedPages.length <= MAX_SEED_PAGES && related <= MAX_SEED_RELATED) return;
  throw new BatchCompileError("compile_batch_unsupported_option", `the schema declares ${schema.seedPages.length} seed pages (at most ${MAX_SEED_PAGES}) with up to ${related} related pages each (at most ${MAX_SEED_RELATED}); a batch compile refuses rather than hold them`);
}

/** The seeds phase. */
export async function runSeeds(run: BatchRun, schema: SchemaConfig): Promise<void> {
  const existedBefore = new Set(schema.seedPages.map((seed) => slugify(seed.title)).filter((slug) => existsSync(path.join(run.root, CONCEPTS_DIR, `${slug}.md`))));
  const generation: PageGenerationResult = { pages: [], writtenPages: [], errors: [], candidates: [], review: { held: [], forced: [] }, seedSlugs: [] };
  await generateSeedPagesWith(BOUNDED_SEED_STEPS, run.root, schema, generation);
  run.counters.seeded = generation.seedSlugs.length;
  for (const slug of generation.seedSlugs) {
    await run.put(`sd:${slug}`, { created: !existedBefore.has(slug) });
    await report(run, { kind: "seed", slug, created: !existedBefore.has(slug) });
  }
  for (const message of generation.errors) await report(run, { kind: "error", message });
  run.counters.pageErrors += generation.errors.length;
  // The incumbent resolves and repairs only when some page changed (a written concept page or a seed page).
  await run.advance(run.counters.pagesWritten + run.counters.seeded > 0 ? "resolve" : "finalize-state", {});
}
