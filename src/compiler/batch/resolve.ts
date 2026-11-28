/**
 * @file src/compiler/batch/resolve.ts
 * @description The RESOLVE phase of a batch compile: the incumbent
 * `resolveLinks`, with bounded memory.
 *
 * TITLE INDEX. Every concept page's linkable title (titled, not orphaned),
 * one page at a time in the directory's listing order, as `tt:<seq>`: the
 * order the incumbent applies titles in. Built with it, the NEW-TITLE
 * PROJECTION `tn:<seq>`: only the titles of pages this run made new, in the
 * same order, so an inbound fold reads the new titles directly instead of
 * rescanning every title and looking up each one's role (pages x titles
 * lookups). A page's role is fixed before this phase (written by the generate
 * and seeds phases), so the projection is the exact filter the fold applied.
 * A run indexed before the projection existed (its cursor without
 * `newTitles`) builds it once from its title index before planning further;
 * a run already applying needs no projection.
 *
 * PAGES. A page this run changed (a written concept page or a seed page) gets
 * OUTBOUND links for every title; a page that is not new gets INBOUND links
 * for the new pages' titles. Both start from the page's ORIGINAL text, and an
 * inbound rewrite supersedes the outbound one, exactly as the incumbent's
 * write map does. Titles are applied through the incumbent `addWikilinks` in
 * chunks, in order: the same fold as one call with all of them (each title is
 * applied to the text the previous ones produced, protections recomputed).
 *
 * TWO PHASES (`./planned-writes.ts`): every rewrite is planned from the
 * ORIGINAL pages before any is written, then the planned bytes are applied,
 * so a crash can never re-plan from a page this phase already rewrote.
 */

import { parseFrontmatter } from "../../utils/markdown.js";
import { CONCEPTS_DIR } from "../../utils/constants.js";
import { addWikilinks, linkableTitleOf, type LinkableTitle } from "../resolver.js";
import { keySeq, seqKey } from "./contracts.js";
import type { GeneratedPageV1 } from "./generate.js";
import { scanPages } from "./page-scan.js";
import { applyPlannedRewrites, planRewrite } from "./planned-writes.js";
import { pageContentBounded } from "./pages.js";
import type { BatchRun } from "./run-store.js";

/** Titles applied per `addWikilinks` call. */
const TITLE_CHUNK = 512;

/** Whether this run changed `slug`'s page, and whether it is new. */
async function pageRole(run: BatchRun, slug: string): Promise<{ changed: boolean; isNew: boolean }> {
  const generated = (await run.get(`gr:${slug}`)) as GeneratedPageV1 | undefined;
  const seeded = (await run.get(`sd:${slug}`)) !== undefined;
  return { changed: seeded || generated?.written === true, isNew: seeded || (generated?.written === true && generated.isNew) };
}

/** Appends titles of new pages to the projection, in the order they are offered. */
function newTitleProjection(run: BatchRun): (title: LinkableTitle) => Promise<boolean> {
  let seq = 0;
  return async (title) => {
    if (!(await pageRole(run, title.slug)).isNew) return false;
    await run.put(seqKey("tn:", seq++), title);
    return true;
  };
}

/** Build the title index and the new-title projection with it; returns whether any indexed page is new. */
async function buildTitleIndex(run: BatchRun): Promise<boolean> {
  let seq = 0;
  let hasNew = false;
  const project = newTitleProjection(run);
  for await (const page of scanPages(run, "ti", CONCEPTS_DIR)) {
    const title = linkableTitleOf(page.content);
    if (title === null) continue;
    const linkable: LinkableTitle = { slug: page.slug, title };
    await run.put(seqKey("tt:", seq++), linkable);
    hasNew = (await project(linkable)) || hasNew;
  }
  return hasNew;
}

/**
 * A run indexed before the new-title projection existed: build it once from
 * the title index (each title's role looked up once), then record it in the
 * cursor. Not needed once its plan is complete (applying reads no titles),
 * nor when no page is new (no inbound fold reads it).
 */
async function ensureNewTitles(run: BatchRun): Promise<void> {
  const { newTitles, planComplete, hasNew } = run.meta.cursor;
  // Without a new page there is no inbound fold to read it.
  if (newTitles === true || planComplete === true || hasNew !== true) return;
  const project = newTitleProjection(run);
  for await (const row of run.scan("tt:")) await project(row.v as LinkableTitle);
  await run.checkpoint({ cursor: { ...run.meta.cursor, newTitles: true } });
}

/** `body` with every indexed title (or only the new pages' titles, from their projection) applied in order, in chunks. */
async function foldTitles(run: BatchRun, body: string, selfTitle: string, onlyNew: boolean): Promise<string> {
  let result = body;
  let chunk: LinkableTitle[] = [];
  for await (const row of run.scan(onlyNew ? "tn:" : "tt:")) {
    const title = row.v as LinkableTitle;
    chunk.push(title);
    if (chunk.length >= TITLE_CHUNK) { result = addWikilinks(result, chunk, selfTitle); chunk = []; }
  }
  return chunk.length > 0 ? addWikilinks(result, chunk, selfTitle) : result;
}

/** The linked body: inbound links (from the original text) win; otherwise a changed page's outbound links. */
async function linkedBody(run: BatchRun, body: string, title: string, rewrite: { inbound: boolean; outbound: boolean }): Promise<string> {
  const fromInbound = rewrite.inbound ? await foldTitles(run, body, title, true) : body;
  if (fromInbound !== body || !rewrite.outbound) return fromInbound;
  return foldTitles(run, body, title, false);
}

/** The rewritten content of one indexed page, or `null` when it does not change. */
async function resolvedContent(run: BatchRun, page: LinkableTitle, hasNew: boolean): Promise<string | null> {
  const role = await pageRole(run, page.slug);
  const rewrite = { inbound: hasNew && !role.isNew, outbound: role.changed };
  if (!rewrite.outbound && !rewrite.inbound) return null;
  const content = await pageContentBounded(run.root, CONCEPTS_DIR, page.slug);
  if (!content) return null;
  const { body } = parseFrontmatter(content);
  const linked = await linkedBody(run, body, page.title, rewrite);
  return linked === body ? null : content.replace(body, () => linked);
}

/** Plan every rewrite from the original pages, after the cursor's `after`, checkpointing every batch. */
async function planResolution(run: BatchRun): Promise<void> {
  const hasNew = run.meta.cursor.hasNew === true;
  let planned = (run.meta.cursor.planned as number | undefined) ?? 0;
  let since = 0;
  for await (const row of run.scan("tt:", seqKey("tt:", (run.meta.cursor.after as number) + 1))) {
    const page = row.v as LinkableTitle;
    const content = await resolvedContent(run, page, hasNew);
    if (content !== null) await planRewrite(run, "rs", planned++, { namespace: "concepts", slug: page.slug, content });
    if ((since += 1) < run.meta.batchSize) continue;
    await run.checkpoint({ cursor: { ...run.meta.cursor, after: keySeq("tt:", row.k), planned } });
    since = 0;
  }
  await run.checkpoint({ cursor: { ...run.meta.cursor, planned, planComplete: true, applied: -1 } });
}

/** The resolve phase: the title index (and new-title projection), the plan from original pages, then the planned bytes applied. */
export async function runResolve(run: BatchRun): Promise<void> {
  if (run.meta.cursor.indexed !== true) {
    const hasNew = await buildTitleIndex(run);
    await run.checkpoint({ cursor: { indexed: true, hasNew, newTitles: true, after: -1, planned: 0 } });
  }
  await ensureNewTitles(run);
  if (run.meta.cursor.planComplete !== true) await planResolution(run);
  await applyPlannedRewrites(run, "rs", (written) => { run.counters.resolved += written; });
  await run.advance("repair");
}
