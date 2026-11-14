/**
 * Repair wikilinks that name an existing page too briefly to resolve.
 *
 * Page generation writes a link using a concept's short canonical name while
 * the page it means carries a longer descriptive title — `[[Argo CD]]` against
 * a page slugged `argo-cd-image-update-ownership-model`. Extraction picks the
 * page titles and generation picks the link text, independently and in that
 * order, so nothing reconciles the two and the link stays broken even though
 * its target is sitting right there on disk.
 *
 * This pass runs once every page is written and rewrites only the link TARGET,
 * never the text around it: the example above becomes
 * `[[argo-cd-image-update-ownership-model|Argo CD]]`. The visible label is
 * retained, while code examples and frontmatter remain untouched.
 *
 * Only an unambiguous prefix match is repaired. A slug that prefixes two pages
 * is left alone rather than guessed at, and so is one that prefixes none: a link
 * to a concept the wiki genuinely lacks is a signal about what is missing, not
 * noise to be hidden.
 *
 * `repairLinksFrom` is THE ONE BODY of the read-and-plan pass and holds no
 * project root: it reaches the project only through {@link LinkRepairSources}.
 * `repairLinks(root)` is a delegate over a private binding built per call. The
 * sources answer FACTS (a listing, a page's text or that it was dropped,
 * whether something is at a path, the pending candidate records); the body
 * owns the order, the listing-failure rule, the dropped-page warning policy
 * and the pending rule. Naming the sources selects no backend and rules on no
 * mechanism; every member of the local binding is still local disk.
 *
 * NOT MIGRATED HERE: applying the planned writes. {@link repairAndApplyLinks}
 * still takes a root and writes through the journalled page writer under the
 * caller's project lock.
 */

import path from "path";
import { diskLocalReads } from "../storage/disk-local-reads.js";
import { diskLocalRecordDirs } from "../storage/disk-local-record-dirs.js";
import type { LegacyLocalRecordDirs } from "../storage/legacy-local-record-dirs.js";
import type { LegacyLocalReads } from "../storage/legacy-local-reads.js";
import { prefetchInOrder } from "../utils/prefetch-in-order.js";
import { parseFrontmatter, slugify } from "../utils/markdown.js";
import { warnDroppedReadIfPresentFrom } from "./confined-wiki-read.js";
import { rewriteWikilinks } from "../wiki/wikilinks.js";
import { listLinkResolvablePendingSlugsFrom } from "./candidate-read.js";
import { applyCompilePageWritesWithIdsLocked } from "./compile-write-ids.js";
import type { PageId } from "../utils/page-id.js";
import type { CompilePageNamespace, CompilePageWrite } from "./compile-write.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import * as output from "../utils/output.js";

/** Separator joining slug words, and therefore the prefix boundary. */
const SLUG_SEPARATOR = "-";

/**
 * Shortest link slug considered for repair. Below this a slug prefixes pages it
 * has nothing to do with — `[[a]]` would claim `a-b-c` — and the uniqueness
 * check cannot tell that apart from a real abbreviation.
 */
const MIN_REPAIRABLE_SLUG_LENGTH = 3;

/**
 * Resolve a broken link slug to the single page it prefixes, or null when it
 * prefixes none or more than one.
 */
function resolveUniquePrefix(targetSlug: string, slugs: string[]): string | null {
  if (targetSlug.length < MIN_REPAIRABLE_SLUG_LENGTH) return null;
  const prefix = targetSlug + SLUG_SEPARATOR;
  let match: string | null = null;
  for (const slug of slugs) {
    if (!slug.startsWith(prefix)) continue;
    if (match) return null;
    match = slug;
  }
  return match;
}

/** Reuse the production retained-only prefix rule, including pending ambiguity. */
export function createRepairResolver(slugs: string[], pending: Set<string>): (target: string) => string | null {
  const existing = new Set(slugs);
  const possible = [...slugs, ...[...pending].filter(slug => !existing.has(slug))];
  // Exact pending targets must not be redirected to a different retained page.
  return (targetSlug: string): string | null => {
    if (existing.has(targetSlug) || pending.has(targetSlug)) return null;
    const match = resolveUniquePrefix(targetSlug, possible);
    return match && existing.has(match) ? match : null;
  };
}

/** Split `target|alias` into its parts, preserving an alias that contains a pipe. */
function splitWikilink(inner: string): { target: string; alias: string } {
  const [rawTarget, ...aliasParts] = inner.split("|");
  const target = rawTarget.trim();
  const alias = aliasParts.length > 0 ? aliasParts.join("|").trim() : target;
  return { target, alias };
}

/** Rewrite every repairable link in a body; returns the body and a repair count. */
function repairBody(
  body: string,
  resolve: (targetSlug: string) => string | null,
): { body: string; repaired: number } {
  let repaired = 0;
  const next = rewriteWikilinks(body, ({ inner }) => {
    const { target, alias } = splitWikilink(inner);
    const resolved = resolve(slugify(target));
    if (!resolved) return undefined;
    repaired += 1;
    return `[[${resolved}|${alias}]]`;
  });
  return { body: next, repaired };
}

/**
 * Everything the read-and-plan pass asks of the project, in the order
 * {@link repairLinksFrom} asks it: for concepts and then for queries, one
 * listing and then one confined read per `.md` name, one after another; then,
 * only when at least one page was read, the pending candidates.
 */
export interface LinkRepairSources {
  /**
   * The page reads. The body calls exactly three of its members and no other:
   * `listNames` for each page directory (a rejection coded `ENOENT` is an
   * empty directory; any other rejection fails the pass); `readConfinedPage`
   * for each `.md` name (a dropped page is a VALUE); and, through the shared
   * warning helper and only for a dropped page, `statNoFollow`.
   */
  pages: LegacyLocalReads;
  /** The pending candidate records, read through the tolerant candidate list. Asked only after the pages, and not at all when there are none. */
  candidates: LegacyLocalRecordDirs;
}

/** LOCAL DISK. The sources for the project at `root`, built per call and private to this module. Building them does no I/O. */
function diskLinkRepairSources(root: string): LinkRepairSources {
  return { pages: diskLocalReads(root), candidates: diskLocalRecordDirs(root) };
}

/**
 * Read only pages whose opened bytes remain within their expected directory.
 * A dropped page is left out, and is warned about ONLY when something is
 * physically at its path: the shared helper makes the no-follow look, treats
 * any failure of that look as "not there", and names the directory-qualified
 * path. A directory's pages are read in parallel first; pages and warnings
 * are then taken in listing order.
 */
async function collectRepairPages(reads: LegacyLocalReads): Promise<Array<{ filePath: string; content: string }>> {
  const pages: Array<{ filePath: string; content: string }> = [];
  for (const dir of [CONCEPTS_DIR, QUERIES_DIR]) {
    const files = await reads.listNames(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const pageFiles = files.filter(file => file.endsWith(".md"));
    const pending = prefetchInOrder(pageFiles, (file) => reads.readConfinedPage(dir, file.slice(0, -3)));
    for (const [index, file] of pageFiles.entries()) {
      const filePath = path.join(dir, file);
      const result = await pending[index];
      if ("dropped" in result) {
        await warnDroppedReadIfPresentFrom(reads, filePath, filePath, result.dropped);
        continue;
      }
      pages.push({ filePath, content: result.content });
    }
  }
  return pages;
}

/** Derive the compile namespace from a page's project-relative file path. */
function namespaceForPage(filePath: string): CompilePageNamespace {
  return path.dirname(filePath).endsWith(path.basename(QUERIES_DIR)) ? "queries" : "concepts";
}

/**
 * COMPUTE the repair rewrites for every page in the project.
 *
 * Scans all pages rather than only changed ones: a link broken today becomes
 * repairable the moment a later compile creates the page it names, and that
 * page's arrival never touches the file holding the link. The pass reads files
 * and calls no model, so the cost is the same order as `llmwiki lint`.
 *
 * @param root - Absolute project root the reads and writes are confined under.
 * @returns One write per page whose body actually changed.
 */
export async function repairLinks(root: string): Promise<CompilePageWrite[]> {
  return repairLinksFrom(diskLinkRepairSources(root));
}

/**
 * {@link repairLinks} through `sources`: THE ONE BODY. Collect the pages; with
 * none, return before the pending candidates are read; otherwise read them,
 * build the resolver, plan one write per changed page in page order, and
 * report the count once at the end.
 */
export async function repairLinksFrom(sources: LinkRepairSources): Promise<CompilePageWrite[]> {
  const pages = await collectRepairPages(sources.pages);
  if (pages.length === 0) return [];

  const slugs = pages.map((page) => path.basename(page.filePath, ".md").toLowerCase());
  const pending = await listLinkResolvablePendingSlugsFrom(sources.candidates);
  const resolve = createRepairResolver(slugs, pending);

  const writes: CompilePageWrite[] = [];
  let repairedLinks = 0;
  for (const page of pages) {
    const { body } = parseFrontmatter(page.content);
    const result = repairBody(body, resolve);
    if (result.repaired === 0) continue;
    repairedLinks += result.repaired;
    writes.push({
      namespace: namespaceForPage(page.filePath),
      slug: path.basename(page.filePath, ".md"),
      body: page.content.replace(body, () => result.body),
    });
  }

  if (repairedLinks > 0) {
    output.status(
      "🔗",
      output.dim(`Repaired ${repairedLinks} wikilink(s) in ${writes.length} page(s)`),
    );
  }
  return writes;
}

/**
 * COMPUTE the repairs and APPLY them in one step — the single seam callers
 * should use, so the "{@link repairLinks} returns writes you MUST apply"
 * contract cannot be forgotten.
 *
 * PRECONDITION: the caller MUST already hold the project lock. This routes
 * through the LOCK-FREE {@link applyCompilePageWritesLocked}, matching how
 * interlink resolution is applied from the same place in the pipeline.
 *
 * @param root - Absolute project root the writes are confined under.
 * @returns Qualified IDs of the pages actually rewritten, excluding floor-skipped writes.
 * @param beforeApply - Optional write-ahead callback for floor-approved page IDs.
 */
export async function repairAndApplyLinks(
  root: string,
  beforeApply?: (pageIds: PageId[]) => Promise<void>,
): Promise<PageId[]> {
  return applyCompilePageWritesWithIdsLocked(root, await repairLinks(root), beforeApply);
}
