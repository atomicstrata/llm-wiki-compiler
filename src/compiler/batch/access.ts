/**
 * @file src/compiler/batch/access.ts
 * @description The COMPILE ACCESS a batch compile hands the incumbent
 * extraction and page generation: the local access (`diskCompileAccess`),
 * with EVERY read it makes bounded, and the run-global ones replaced:
 * - a source is read through the bounded confined reader and must still hash
 *   to the run's listing (`compile_batch_inputs_changed` otherwise);
 * - the extraction index (`wiki/index.md`, constant until the residual phase)
 *   is read once per attempt through the bounded confined page read, refused
 *   above {@link MAX_INDEX_BYTES} (the cap the index is published under); a dropped or absent index is the
 *   incumbent's empty index (warned only when something is at its path);
 * - a concept page is read through the bounded confined page read (refused
 *   above the page cap), its drop warned exactly as the incumbent
 *   `readWikiPageContentOrWarn` warns (always, or only when present);
 * - a source hash (the incumbent `hashSource`, same SHA-256 of the text) is
 *   taken over the bounded source read;
 * - the citation check (always run on a generated page) asks only whether a
 *   barely cited source exists, and counts a span-cited source's lines
 *   through the capped confined read (an oversized one refuses);
 * - the related-page context is the SNAPSHOT the plan took before any page of
 *   this run was written (the first concept pages in the incumbent's listing
 *   order, their contents as they were), because the incumbent writes every
 *   page only after all are generated: so every page sees the same context;
 * - the whole-project reads a batch compile never makes refuse if reached.
 */

import path from "node:path";
import { diskCompileAccess, type CompileAccess } from "../compile-access.js";
import { warnDroppedReadIfPresentFrom, warnDroppedWikiRead } from "../confined-wiki-read.js";
import { diskLocalReads } from "../../storage/disk-local-reads.js";
import { checkPageCitationsWith, countLines } from "../../linter/rules-citations.js";
import type { LintResult } from "../../linter/types.js";
import { openConfinedLeaf, readConfirmedBufferOrElse } from "../../utils/confined-read.js";
import { CONCEPTS_DIR, INDEX_FILE, SOURCES_DIR } from "../../utils/constants.js";
import { BatchCompileError } from "./contracts.js";
import type { ListedSourceV1 } from "./detect.js";
import { MAX_INDEX_BYTES, MAX_PAGE_BYTES, readPageBounded } from "./pages.js";
import type { BatchRun } from "./run-store.js";
import { MAX_SOURCE_BYTES, readSourceBounded } from "./sources.js";

/** One related page as the plan snapshotted it. */
export interface RelatedPageV1 { readonly name: string; readonly content: string }

/** A whole-project read the batch route never makes. */
function unreachable(name: string): never {
  throw new BatchCompileError("compile_batch_unsupported_option", `${name} is a whole-project read the batch compile does not make`);
}

/** The index text, read once per attempt, bounded, with the incumbent's drop semantics. */
function indexOnce(root: string): () => Promise<string> {
  let index: Promise<string> | undefined;
  return () => {
    index ??= (async () => {
      const read = await readPageBounded(root, path.dirname(INDEX_FILE), path.basename(INDEX_FILE, ".md"), MAX_INDEX_BYTES);
      if ("content" in read) return read.content;
      // An absent index shares the drop reason; the incumbent warns only when index.md physically exists.
      await warnDroppedReadIfPresentFrom(diskLocalReads(root), INDEX_FILE, INDEX_FILE, read.dropped);
      return "";
    })();
    return index;
  };
}

/** One concept page, bounded, warned on a drop as the incumbent warns. */
async function conceptPage(root: string, slug: string, warnAlways = true): Promise<string> {
  const read = await readPageBounded(root, CONCEPTS_DIR, slug);
  if ("content" in read) return read.content;
  const relPath = path.join(CONCEPTS_DIR, `${slug}.md`);
  if (warnAlways) warnDroppedWikiRead(relPath, read.dropped);
  else await warnDroppedReadIfPresentFrom(diskLocalReads(root), relPath, relPath, read.dropped);
  return "";
}

/** Refuse a cited source too large to count within the batch source cap. */
function citedTooLarge(filename: string, bytes: number): never {
  throw new BatchCompileError("compile_batch_source_unreadable", `cited source ${filename.slice(0, 80)} is ${bytes} bytes, over the ${MAX_SOURCE_BYTES}-byte batch source cap; a span citation to it cannot be checked`);
}

/** The line count of cited source `filename`: a confined, capped, race-checked read; unreadable (or outside sources/) counts as empty, as the incumbent's failed read does. */
async function citedLineCount(root: string, filename: string): Promise<number> {
  const dir = path.join(root, SOURCES_DIR);
  const leaf = path.join(dir, filename);
  if (path.relative(dir, leaf).startsWith("..") || path.isAbsolute(path.relative(dir, leaf))) return countLines("");
  const opened = await openConfinedLeaf(root, leaf, path.dirname(leaf));
  if (opened.kind !== "confirmed") return countLines("");
  // The oversize answer is a value: the reader runs it inside its own catch-all, so a throw there would be swallowed.
  const read = await readConfirmedBufferOrElse(opened, MAX_SOURCE_BYTES, (bytes) => ({ kind: "oversize" as const, bytes }));
  if (read.kind === "oversize") citedTooLarge(filename, read.bytes);
  return countLines(read.kind === "ok" ? read.body.toString("utf8") : "");
}

/**
 * The incumbent citation check (the shared `checkPageCitationsWith`) over a
 * BOUNDED lookup: a bare citation only asks whether the source exists (no
 * read); a span citation counts the source's lines through the capped read,
 * once per source per page. The page itself must be within the page cap.
 */
async function checkCitationsBounded(root: string, fullPage: string, virtualPath: string): Promise<LintResult[]> {
  if (Buffer.byteLength(fullPage) > MAX_PAGE_BYTES) throw new BatchCompileError("compile_batch_page_too_large", `generated page ${virtualPath.slice(0, 80)} is over the ${MAX_PAGE_BYTES}-byte batch page cap`);
  const reads = diskLocalReads(root);
  const counted = new Map<string, number>();
  return checkPageCitationsWith(fullPage, virtualPath, {
    exists: (filename) => reads.exists(path.join(SOURCES_DIR, filename)),
    lineCount: async (filename) => {
      if (!counted.has(filename)) counted.set(filename, await citedLineCount(root, filename));
      return counted.get(filename)!;
    },
  });
}

/** The bounded source read, which must still match the run's listing. */
async function listedSource(run: BatchRun, file: string): Promise<string> {
  const read = await readSourceBounded(run.root, file);
  const listed = (await run.get(`f:${file}`)) as ListedSourceV1 | undefined;
  if (listed?.hash !== read.hash) throw new BatchCompileError("compile_batch_inputs_changed", `source ${file.slice(0, 80)} changed after the batch compile listed it; re-run the compile`);
  return read.text;
}

/** The batch compile's access for the project at `root` within `run`. */
export function batchAccess(run: BatchRun, related: readonly RelatedPageV1[] = []): CompileAccess {
  const root = run.root;
  const snapshot = new Map(related.map((page) => [page.name.slice(0, -".md".length), page.content]));
  return {
    ...diskCompileAccess(root),
    readSource: (file) => listedSource(run, file),
    hashSource: async (file) => (await readSourceBounded(root, file)).hash,
    checkBrokenCitations: (fullPage, virtualPath) => checkCitationsBounded(root, fullPage, virtualPath),
    readExtractionIndex: indexOnce(root),
    listConceptPageFiles: async () => related.map((page) => page.name),
    readConceptPage: async (slug, warnAlways) => (snapshot.has(slug) ? snapshot.get(slug)! : conceptPage(root, slug, warnAlways)),
    listConceptTitles: async () => unreachable("listConceptTitles"),
    pendingSourceStates: async () => unreachable("pendingSourceStates"),
    detectChanges: async () => unreachable("detectChanges"),
    readState: async () => unreachable("readState"),
  };
}
