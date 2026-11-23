/**
 * @file src/compiler/batch/generation-plan.ts
 * @description The PLAN-GENERATION phase of a batch compile: everything the
 * incumbent `generatePagesPhase` decides before its first page call, with
 * bounded memory and NO provider call.
 *
 * - AFFECTED PAGES (`ap:<slug>`): the reconciliation slugs, plus every fresh
 *   (not reused) extraction's previous and extracted slugs.
 * - GENERATION ORDER (`go:<n>` → `{slug, title}`): the incumbent merge's
 *   first-appearance order over the extractions and their concepts, skipping
 *   frozen and unaffected slugs; its title is the first contribution's.
 * - FAN-IN PREFLIGHT: EVERY planned page's contributors and its whole merged
 *   input (source texts, concept metadata, source names, slice headers) are
 *   counted from the contribution index; one above `MAX_PAGE_OWNERS` or
 *   `MAX_PAGE_INPUT_BYTES` refuses the run (`compile_batch_fanin_exceeded`)
 *   before any page is generated.
 * - LINK TARGETS (`lt`): the incumbent `buildLinkTargets` — this run's
 *   concepts, then the existing concept pages' linkable titles, each sorted
 *   by title (`./external-sort.ts`), deduplicated by slug and selected
 *   greedily within `LINK_TARGET_BUDGET_CHARS` — the same list for every page.
 *   Existing pages are read one at a time in the directory's listing order
 *   (the order the incumbent sorts them from, so ties break as it does).
 * - RELATED CONTEXT (`rp:<i>`): the first concept pages in the original
 *   directory listing order, as they are now: the context every page of this
 *   run is generated with (the incumbent generates every page before writing
 *   any, and selects from its directory listing).
 */

import type { LegacyLocalReads } from "../../storage/legacy-local-reads.js";
import { CONCEPTS_DIR } from "../../utils/constants.js";
import { slugify } from "../../utils/markdown.js";
import { LINK_TARGET_BUDGET_CHARS, renderTarget, type PageRef } from "../link-targets.js";
import { RELATED_PAGE_CONTEXT_LIMIT } from "../page-renderer.js";
import { linkableTitleOf } from "../resolver.js";
import type { RelatedPageV1 } from "./access.js";
import { BatchCompileError, contributionsPrefix, MAX_PAGE_INPUT_BYTES, MAX_PAGE_OWNERS, parseContributionKey, seqKey } from "./contracts.js";
import { ExternalSorter } from "./external-sort.js";
import type { ExtractionRowV1 } from "./extract.js";
import { listedPageNames, scanPages } from "./page-scan.js";
import { pageContentBounded } from "./pages.js";
import type { BatchRun } from "./run-store.js";

/** One planned page: its slug and the title it is linked by. */
export interface PlannedPageV1 { readonly slug: string; readonly title: string }

/** Bytes a contribution's slice adds beyond its text and file name (header, numbering, separators), counted generously. */
const SLICE_OVERHEAD_BYTES = 256;
/** The smallest rendered target: one character and its separator. */
const MIN_TARGET_SIZE = 4;

/** The affected page slugs: reconciliation, then fresh extractions' previous and extracted slugs. */
async function affectedPages(run: BatchRun): Promise<void> {
  for await (const row of run.scan("rso:")) await run.put(`ap:${row.v as string}`, 1);
  for await (const row of run.scan("x:")) {
    const extraction = row.v as ExtractionRowV1;
    if (extraction.reused) continue;
    for (const slug of extraction.previousConcepts ?? []) await run.put(`ap:${slug}`, 1);
    for (const concept of extraction.concepts) await run.put(`ap:${slugify(concept.concept)}`, 1);
  }
}

/** The generation order: first appearance of each affected, unfrozen slug. */
async function generationOrder(run: BatchRun): Promise<number> {
  let next = 0;
  for await (const row of run.scan("x:")) {
    for (const concept of (row.v as ExtractionRowV1).concepts) {
      const slug = slugify(concept.concept);
      if ((await run.get(`fz:${slug}`)) !== undefined || (await run.get(`ap:${slug}`)) === undefined || (await run.get(`gs:${slug}`)) !== undefined) continue;
      await run.put(`gs:${slug}`, next);
      await run.put(seqKey("go:", next++), { slug, title: concept.concept } satisfies PlannedPageV1);
    }
  }
  return next;
}

/** Refuse before any generation when any planned page merges more owners or source bytes than the caps. */
async function fanInPreflight(run: BatchRun): Promise<void> {
  for await (const row of run.scan("go:")) {
    const { slug } = row.v as PlannedPageV1;
    let owners = 0;
    let bytes = 0;
    for await (const contribution of run.scan(contributionsPrefix(slug))) {
      owners += 1;
      const { seq, idx } = parseContributionKey(contribution.k);
      const extraction = (await run.get(seqKey("x:", seq))) as ExtractionRowV1;
      // The whole merged input: the source text, its concept metadata, and its name in `sourceFiles` and the slice header.
      bytes += extraction.bytes + Buffer.byteLength(JSON.stringify(extraction.concepts[idx])) + 2 * Buffer.byteLength(extraction.file) + SLICE_OVERHEAD_BYTES;
      if (owners > MAX_PAGE_OWNERS || bytes > MAX_PAGE_INPUT_BYTES) {
        throw new BatchCompileError("compile_batch_fanin_exceeded", `page ${slug.slice(0, 80)} would merge more than ${MAX_PAGE_OWNERS} contributions or ${MAX_PAGE_INPUT_BYTES} source bytes (at least ${owners} contributions, ${bytes} bytes); no page was generated`);
      }
    }
  }
}

/** The existing concept pages' linkable titles, read one at a time in the directory's listing order. */
async function existingTitles(run: BatchRun, sorter: ExternalSorter<PageRef>): Promise<void> {
  for await (const page of scanPages(run, "lt", CONCEPTS_DIR)) {
    const title = linkableTitleOf(page.content);
    if (title !== null) await sorter.add({ slug: page.slug, title });
  }
}

/**
 * Snapshot the related-page context every page of this run is generated
 * with: the first `.md` concept pages in the ORIGINAL directory listing order
 * (one more than the incumbent limit, so excluding a page's own leaves
 * enough; the stream stops there), as they are before any page of this run is
 * written.
 */
async function relatedSnapshot(run: BatchRun): Promise<RelatedPageV1[]> {
  const names: string[] = [];
  for await (const name of listedPageNames(run, "rpn", CONCEPTS_DIR)) {
    names.push(name);
    if (names.length > RELATED_PAGE_CONTEXT_LIMIT) break;
  }
  const pages: RelatedPageV1[] = [];
  for (const name of names) pages.push({ name, content: await pageContentBounded(run.root, CONCEPTS_DIR, name.slice(0, -".md".length)) });
  return pages;
}

/** Select the link targets greedily from the two sorted streams (the incumbent `renderSorted` then budget loop). */
async function selectTargets(run: BatchRun, streams: AsyncGenerator<PageRef>[]): Promise<string[]> {
  const targets: string[] = [];
  let used = 0;
  for (const stream of streams) {
    for await (const ref of stream) {
      if (LINK_TARGET_BUDGET_CHARS - used < MIN_TARGET_SIZE) return targets;
      const key = `lts:${ref.slug.toLowerCase()}`;
      const target = (await run.get(key)) !== undefined ? null : renderTarget(ref);
      if (target === null) continue;
      await run.put(key, 1);
      if (used + target.length + 3 > LINK_TARGET_BUDGET_CHARS) continue;
      targets.push(target);
      used += target.length + 3;
    }
  }
  return targets;
}

/** The link targets of this run's pages. */
async function linkTargets(run: BatchRun): Promise<string[]> {
  const byTitle = (a: PageRef, b: PageRef): number => a.title.localeCompare(b.title);
  const current = new ExternalSorter<PageRef>(run, "ltc:", byTitle);
  for await (const row of run.scan("go:")) await current.add(row.v as PlannedPageV1);
  const existing = new ExternalSorter<PageRef>(run, "lte:", byTitle);
  await existingTitles(run, existing);
  return selectTargets(run, [current.sorted(), existing.sorted()]);
}

/** The plan-generation phase (no provider call; one checkpoint). */
export async function runGenerationPlan(run: BatchRun, reads: LegacyLocalReads): Promise<void> {
  await affectedPages(run);
  run.counters.pagesPlanned = await generationOrder(run);
  await fanInPreflight(run);
  // Link targets and related context feed page prompts only: with no page planned, the incumbent computes neither.
  if (run.counters.pagesPlanned > 0) {
    await run.put("lt", await linkTargets(run));
    const related = await relatedSnapshot(run);
    for (let at = 0; at < related.length; at += 1) await run.put(seqKey("rp:", at), related[at]);
  }
  await run.advance("generate", { after: -1 });
}
