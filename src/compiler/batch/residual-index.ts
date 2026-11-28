/**
 * @file src/compiler/batch/residual-index.ts
 * @description The index and MOC steps of a batch compile's RESIDUAL phase:
 * the incumbent `generateIndex` and `generateMOC`, rendered by the incumbent
 * line renderers, with bounded memory.
 *
 * INDEX. The concept, then the saved-query pages are streamed one at a time
 * (`./page-scan.ts`, in directory listing order); the titled, non-orphaned
 * rows (the incumbent `summariesOf`) go through the run's stable external sort
 * by `title.localeCompare`, so ties keep listing order exactly as the
 * incumbent's in-memory sort. For a custom profile the typed sections come
 * from the typed entity catalog (just reconciled): its declared types in
 * code-unit order, each type's listed pages by `slug.localeCompare`, a type
 * with no page omitted.
 *
 * MOC. Each non-empty, non-orphaned concept page contributes one entry per tag
 * (duplicates kept), or one under "Uncategorized". The entries are sorted by
 * the incumbent tag order ("Uncategorized" last, else `localeCompare`), tags
 * that compare equal kept apart in first-appearance order, then by
 * `title.localeCompare`, stable in listing order.
 *
 * OUTPUT. Each page is STREAMED, line by line in its sorted order, into the
 * bound temp of the incumbent confined atomic replacement
 * (`atomicWriteStreamed`: same ancestor guard, parent binding and rename as
 * `replaceLeafAtomicWithin`), with exactly the incumbent's bytes (lines joined
 * by "\n"); nothing holds the whole page. A page that would pass its cap
 * refuses and its temp is removed, leaving the published page untouched. The
 * index's cap is {@link MAX_INDEX_BYTES}, the cap its extraction read holds it
 * to (a batch never publishes an index the next batch cannot read); the MOC,
 * which no compile reads back, keeps {@link MAX_MOC_BYTES}.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { asEntityFileRow, collectOne, isEntityDirKey, parseEntityKey } from "../../catalog/entity-rows.js";
import { openActiveCatalog } from "../../catalog/routes.js";
import { loadNonDefaultProfile } from "../../profile/block.js";
import type { EntityPageView, LoadedProfile } from "../../profile/types.js";
import type { FileHandle } from "node:fs/promises";
import { atomicWriteStreamed } from "../../utils/atomic-write.js";
import { CONCEPTS_DIR, INDEX_FILE, MOC_FILE, QUERIES_DIR } from "../../utils/constants.js";
import { parseFrontmatter } from "../../utils/markdown.js";
import * as output from "../../utils/output.js";
import type { PageSummary } from "../../utils/types.js";
import { entityEntryLine, entitySectionHeading, indexEntryLine, indexFooterLines, summariesOf } from "../indexgen.js";
import { compareMocTags, mocEntryLine, mocPageInfo } from "../obsidian.js";
import { BatchCompileError } from "./contracts.js";
import { MAX_INDEX_BYTES } from "./pages.js";
import { BATCH_ENTITY_PAGE_BOUND } from "./entity-bound.js";
import { ExternalSorter } from "./external-sort.js";
import { scanPages } from "./page-scan.js";
import type { BatchRun } from "./run-store.js";

/** Largest MOC a batch compile publishes (no compile reads it back). */
const MAX_MOC_BYTES = 64 * 1024 * 1024;

/** Bytes buffered before one write to the temp. */
const LINE_FLUSH_BYTES = 64 * 1024;

/** A page's lines streamed into its temp (joined by "\n", as the incumbent joins them), within its cap. */
class LineStream {
  private pending = "";
  private bytes = 0;
  private first = true;

  constructor(private readonly handle: FileHandle, private readonly name: string, private readonly cap: number) {}

  /** Append lines; refuses past the cap. */
  async push(...lines: string[]): Promise<void> {
    for (const line of lines) {
      const piece = this.first ? line : `\n${line}`;
      this.first = false;
      this.bytes += Buffer.byteLength(piece);
      if (this.bytes > this.cap) throw new BatchCompileError("compile_batch_page_too_large", `${this.name} would exceed ${this.cap} bytes; a batch compile refuses rather than publish it`);
      this.pending += piece;
      if (this.pending.length >= LINE_FLUSH_BYTES) await this.flush();
    }
  }

  /** Write the buffered text, all of it (`writeFile` on a handle writes from its position until every byte is written). */
  async flush(): Promise<void> {
    if (this.pending.length > 0) await this.handle.writeFile(this.pending);
    this.pending = "";
  }
}

/** Publish `relPath` of the project at `root` from the lines `render` streams, refusing past `cap` bytes. */
async function publishLines(root: string, relPath: string, name: string, cap: number, render: (out: LineStream) => Promise<void>): Promise<void> {
  await atomicWriteStreamed(path.join(root, relPath), async (handle) => {
    const out = new LineStream(handle, name, cap);
    await render(out);
    await out.flush();
  }, { confineRoot: root });
}

/** Title order of index rows. */
const byTitle = (a: { title: string }, b: { title: string }): number => a.title.localeCompare(b.title);

/** The sorted index rows of one page directory; returns how many were rendered. */
async function summaryLines(run: BatchRun, ns: string, relDir: string, lines: LineStream, heading: string[]): Promise<number> {
  const sorter = new ExternalSorter<PageSummary>(run, `${ns}s:`, byTitle);
  for await (const page of scanPages(run, ns, relDir)) for (const row of summariesOf([{ slug: page.slug, meta: parseFrontmatter(page.content).meta }])) await sorter.add(row);
  let count = 0;
  for await (const row of sorter.sorted()) {
    if (count++ === 0) await lines.push(...heading);
    await lines.push(indexEntryLine(row));
  }
  return count;
}

/** The listed page view of one typed catalog row (a `live` view re-projected from its file, under the batch bound), or `null`. */
async function entityViewOf(run: BatchRun, loaded: LoadedProfile, key: string, value: unknown): Promise<Omit<EntityPageView, "body"> | null> {
  const row = asEntityFileRow(value, key);
  if (row.page !== "live") return row.page;
  const { type, stem } = parseEntityKey(key);
  return (await collectOne(run.root, loaded, type, `${stem}.md`, BATCH_ENTITY_PAGE_BOUND)).page;
}

/** The typed sections of a custom profile; returns how many pages were rendered. */
async function entityLines(run: BatchRun, lines: LineStream): Promise<number> {
  const loaded = await loadNonDefaultProfile(run.root);
  if (loaded === undefined) return 0;
  const catalog = await openActiveCatalog(run.root);
  let total = 0;
  const types = Object.keys(loaded.profile.entities).sort();
  for (let at = 0; at < types.length; at += 1) {
    const sorter = new ExternalSorter<Omit<EntityPageView, "body">>(run, `ixe${at}:`, (a, b) => a.slug.localeCompare(b.slug));
    for await (const row of catalog.scan({ prefix: `e:${types[at]}/` })) {
      const view = isEntityDirKey(row.k) ? null : await entityViewOf(run, loaded, row.k, row.v);
      if (view !== null) await sorter.add(view);
    }
    let count = 0;
    for await (const view of sorter.sorted()) {
      if (count++ === 0) await lines.push(...entitySectionHeading(types[at]!));
      await lines.push(entityEntryLine(view));
    }
    total += count;
  }
  return total;
}

/** The index step: render and publish `wiki/index.md`, refusing past `cap` (the extraction read cap; a test passes a smaller one to reach the boundary). */
export async function generateIndexBounded(run: BatchRun, cap = MAX_INDEX_BYTES): Promise<void> {
  output.status("*", output.info("Generating index..."));
  let total = 0;
  await publishLines(run.root, INDEX_FILE, "the index", cap, async (lines) => {
    await lines.push("# Knowledge Wiki", "", "## Concepts", "");
    const concepts = await summaryLines(run, "ixc", CONCEPTS_DIR, lines, []);
    const queries = await summaryLines(run, "ixq", QUERIES_DIR, lines, ["", "## Saved Queries", ""]);
    total = concepts + queries + (await entityLines(run, lines));
    await lines.push(...indexFooterLines(total));
  });
  output.status("+", output.success(`Index updated with ${total} pages.`));
}

/** One MOC entry: its tag, the tag's first-appearance index, and the page. */
interface MocEntryV1 { readonly tag: string; readonly at: number; readonly slug: string; readonly title: string }

/** MOC order: one tag's entries by title; distinct tags by the incumbent tag order, equal-comparing ones by first appearance. */
function mocOrder(a: MocEntryV1, b: MocEntryV1): number {
  if (a.at === b.at) return a.title.localeCompare(b.title);
  return compareMocTags(a.tag, b.tag) || a.at - b.at;
}

/** The first-appearance index of `tag`, assigning the next one on first sight. */
async function tagIndex(run: BatchRun, tag: string, next: { value: number }): Promise<number> {
  const key = `mt:${createHash("sha256").update(JSON.stringify(tag)).digest("hex")}`;
  const known = (await run.get(key)) as number | undefined;
  if (known !== undefined) return known;
  await run.put(key, next.value);
  return next.value++;
}

/** The MOC step: render and publish `wiki/MOC.md`. */
export async function generateMocBounded(run: BatchRun): Promise<void> {
  const sorter = new ExternalSorter<MocEntryV1>(run, "mcs:", mocOrder);
  const next = { value: 0 };
  for await (const page of scanPages(run, "mc", CONCEPTS_DIR)) {
    const info = mocPageInfo(page.slug, page.content);
    if (info === null) continue;
    for (const tag of info.tags.length === 0 ? ["Uncategorized"] : info.tags) await sorter.add({ tag, at: await tagIndex(run, tag, next), slug: info.slug, title: info.title });
  }
  await publishLines(run.root, MOC_FILE, "the MOC", MAX_MOC_BYTES, async (lines) => {
    await lines.push("# Map of Content", "");
    let current = -1;
    for await (const entry of sorter.sorted()) {
      if (entry.at !== current) {
        if (current !== -1) await lines.push("");
        await lines.push(`## ${entry.tag}`, "");
        current = entry.at;
      }
      await lines.push(mocEntryLine(entry));
    }
    if (current !== -1) await lines.push("");
  });
}
