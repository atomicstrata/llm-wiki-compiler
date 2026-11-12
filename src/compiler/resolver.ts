/**
 * Interlink resolution for wiki pages.
 *
 * Rule-based (not LLM-based) pass that scans wiki pages for concept title
 * mentions and wraps them in [[slug|Title]] wikilinks. The piped alias form
 * keeps Obsidian link resolution stable when a page's filename (slug) differs
 * from its display title.
 *
 * Complexity: O(changed * total) per incremental compile.
 * Full recompile degrades to O(total^2).
 *
 * STORAGE. The planner has ONE BODY, {@link resolveLinksFrom}, over the raw
 * legacy-local reads ({@link LegacyLocalReads}) it lists and reads pages
 * through; {@link resolveLinks} hands it the local disk's. Applying the planned
 * writes ({@link resolveAndApplyLinks}) stays root-bound under the caller's lock.
 * The reads are the internal legacy-local contract: not `ProjectStore`, not a
 * hosted or access-controlled store, and not public API.
 */

import { parseFrontmatter } from "../utils/markdown.js";
import { diskLocalReads } from "../storage/disk-local-reads.js";
import type { LegacyLocalReads } from "../storage/legacy-local-reads.js";
import { readOncePages } from "../storage/read-once-pages.js";
import { readWikiPageContentOrWarnFrom } from "./confined-wiki-read.js";
import { CONCEPTS_DIR } from "../utils/constants.js";
import { applyCompilePageWritesWithIdsLocked } from "./compile-write-ids.js";
import { isLiteralMarkdown } from "./link-repair-code.js";
import { insertsOnlyALink } from "../wiki/wikilink-insertion.js";
import type { PageId } from "../utils/page-id.js";
import type { CompilePageNamespace, CompilePageWrite } from "./compile-write.js";
import * as output from "../utils/output.js";

/**
 * The namespace of every planned write. The title index is listed from
 * {@link CONCEPTS_DIR} only, and the namespace was derived from a page's path
 * inside that directory, which always named `concepts`: the directory's last
 * segment is `concepts`, and a listed file name holds no separator. So the
 * constant is that derivation, with no project root or absolute path involved.
 */
const TITLE_INDEX_NAMESPACE: CompilePageNamespace = "concepts";

/** A concept page that can be linked to, by slug and title. */
export interface LinkableTitle {
  slug: string;
  title: string;
}

/**
 * Every linkable concept title, with the listing and each page read through
 * `reads`. Each page is read through the confined helper, so an entry whose
 * target escapes `wiki/concepts` is dropped (warned, skipped) and never enters
 * the title index, so its bytes can never be re-emitted into a rewritten page.
 */
export async function listLinkableTitlesFrom(reads: LegacyLocalReads): Promise<LinkableTitle[]> {
  if (!(await reads.exists(CONCEPTS_DIR))) return [];

  const files = await reads.listNames(CONCEPTS_DIR);
  const slugs = files.filter((file) => file.endsWith(".md")).map((file) => file.replace(/\.md$/, ""));
  // Read every page in parallel up front; the in-order loop below then finds each one ready.
  const pageReads = readOncePages(reads);
  await pageReads.prefetchPages(CONCEPTS_DIR, slugs);
  const titles: LinkableTitle[] = [];

  for (const slug of slugs) {
    const content = await readWikiPageContentOrWarnFrom(pageReads, CONCEPTS_DIR, slug);
    const title = linkableTitleOf(content);
    if (title !== null) titles.push({ slug, title });
  }

  return titles;
}

/**
 * The title a page can be linked by, or `null` when it has none or is orphaned.
 * Pure, so a title index built from a store that is not a directory admits
 * exactly the pages this one does.
 */
function linkableTitleOf(content: string): string | null {
  if (!content) return null;
  const { meta } = parseFrontmatter(content);
  return meta.title && typeof meta.title === "string" && !meta.orphaned ? meta.title : null;
}

/** Check if a position is inside an existing [[wikilink]]. */
function isInsideWikilink(text: string, position: number): boolean {
  const before = text.lastIndexOf("[[", position);
  const after = text.indexOf("]]", position);
  if (before === -1 || after === -1) return false;

  const closeBefore = text.indexOf("]]", before);
  return closeBefore >= position;
}

/** Check if a position is inside a ^[...] citation marker. */
function isInsideCitation(text: string, position: number): boolean {
  const before = text.lastIndexOf("^[", position);
  const after = text.indexOf("]", position);
  if (before === -1 || after === -1) return false;

  const closeBefore = text.indexOf("]", before);
  return closeBefore >= position;
}

/** Check if a match is at a word boundary. */
function isWordBoundary(text: string, start: number, end: number): boolean {
  const before = start === 0 || /[\s,.:;!?()\[\]{}/"']/.test(text[start - 1]);
  const after = end >= text.length || /[\s,.:;!?()\[\]{}/"']/.test(text[end]);
  return before && after;
}

/** Find all regex matches for a title in the text, returned as position spans. */
function findTitleMatches(text: string, title: string): { start: number; end: number }[] {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(escaped, "gi");
  const matches: { start: number; end: number }[] = [];
  let match;

  while ((match = regex.exec(text)) !== null) {
    matches.push({ start: match.index, end: match.index + match[0].length });
  }

  return matches;
}

/** Determine whether a match position is eligible for wikilink insertion. */
function isLinkablePosition(
  text: string,
  start: number,
  end: number,
  isLiteral: (offset: number) => boolean,
): boolean {
  if (isLiteral(start)) return false;
  if (isInsideWikilink(text, start)) return false;
  if (isInsideCitation(text, start)) return false;
  return isWordBoundary(text, start, end);
}

/**
 * Literal-region lookup that parses a body only when it has changed. Parsing is
 * the costly step, and most titles either do not occur in a page or occur only
 * in protected text, so the same body is otherwise re-parsed once per title.
 */
function cachedLiteralRegions(): (text: string) => (offset: number) => boolean {
  let parsedText: string | null = null;
  let isLiteral: (offset: number) => boolean = () => false;
  return (text) => {
    if (text !== parsedText) {
      parsedText = text;
      isLiteral = isLiteralMarkdown(text, { htmlBlocks: true });
    }
    return isLiteral;
  };
}

/**
 * Add [[wikilinks]] to a page's body for any title mentions.
 * Skips literal Markdown (fenced, indented and inline code, HTML blocks),
 * already-linked text, citations, non-word-boundary matches, and any place
 * the renderer would not read a link: Markdown link URLs and text, autolinks,
 * image alt text and reference definitions.
 */
function addWikilinks(body: string, titles: LinkableTitle[], selfTitle: string): string {
  let result = body;
  const literalRegions = cachedLiteralRegions();
  const selfLower = selfTitle.toLowerCase();

  for (const page of titles) {
    if (page.title.toLowerCase() === selfLower) continue;

    const matches = findTitleMatches(result, page.title);
    if (matches.length === 0) continue;
    // Code is copied verbatim by readers, so a title inside it is never linked.
    // Matches are rewritten last-first, so each insertion only shifts text after
    // the positions still to check; regions found once per title stay valid.
    const isLiteral = literalRegions(result);

    // Process matches in reverse to preserve positions
    const link = `[[${page.slug}|${page.title}]]`;
    for (const m of matches.reverse()) {
      if (!isLinkablePosition(result, m.start, m.end, isLiteral)) continue;
      // The cheap checks above cannot see Markdown links, autolinks, image alt
      // text or reference definitions; the renderer can.
      if (!insertsOnlyALink(result, m, link, page.title)) continue;
      result = result.slice(0, m.start) + link + result.slice(m.end);
    }
  }

  return result;
}

/**
 * COMPUTE interlink resolution for changed and affected pages, returning the
 * rewritten page bodies as {@link CompilePageWrite}s for the CALLER to apply as
 * ONE journalled resolution batch (instead of an inline `atomicWrite`).
 *
 * Two passes:
 * 1. Outbound: changed pages get [[wikilinks]] for any title they mention.
 * 2. Inbound: every indexed page except the new ones gets scanned for mentions
 *    of newly created titles.
 *    This ensures existing pages link to new concepts without a full recompile.
 *
 * Complexity: O(changed * total) for outbound, O(newTitles * total) for inbound.
 * @returns The rewritten pages (one per page whose body actually changed).
 */
export async function resolveLinks(
  root: string,
  changedSlugs: string[],
  newSlugs: string[],
): Promise<CompilePageWrite[]> {
  // `async` so that a throw while the disk reads are built REJECTS.
  return resolveLinksFrom(diskLocalReads(root), changedSlugs, newSlugs);
}

/**
 * {@link resolveLinks} over {@link LegacyLocalReads}: THE ONE BODY. The title
 * index is listed first (none means nothing to plan), then the outbound pass
 * over the changed pages, then the inbound pass, which scans every indexed
 * page EXCEPT the new ones (as it always has) for the new titles. A page
 * planned by both passes keeps its first position with the inbound body.
 *
 * @param reads - The raw legacy-local reads the listing and every page read go through.
 * @param changedSlugs - Slugs whose pages get outbound links re-resolved.
 * @param newSlugs - Newly-created slugs other pages get scanned for (inbound).
 * @returns The rewritten pages (one per page whose body actually changed).
 */
export async function resolveLinksFrom(
  reads: LegacyLocalReads,
  changedSlugs: string[],
  newSlugs: string[],
): Promise<CompilePageWrite[]> {
  // Nothing is written until the caller applies the result, so the title index,
  // outbound and inbound passes share one read of each page.
  const pageReads = readOncePages(reads);
  const titleIndex = await listLinkableTitlesFrom(pageReads);
  if (titleIndex.length === 0) return [];

  // Pass 1 (outbound) on changed pages, then Pass 2 (inbound) on all pages,
  // de-duplicated by slug so a page changed in both passes is written once with
  // the latest body (inbound supersedes outbound for the same page).
  const writes = new Map<string, CompilePageWrite>();
  for (const write of await resolveOutboundLinks(pageReads, titleIndex, changedSlugs)) {
    writes.set(write.slug, write);
  }
  for (const write of await resolveInboundLinks(pageReads, titleIndex, newSlugs)) {
    writes.set(write.slug, write);
  }

  if (writes.size > 0) {
    output.status("🔗", output.dim(`Resolved links in ${writes.size} page(s)`));
  }
  return [...writes.values()];
}

/**
 * COMPUTE interlink resolution and APPLY the rewrites in one step — the single
 * seam every resolution caller should use so the "{@link resolveLinks} returns
 * writes you MUST apply" contract can never be forgotten (its return value is no
 * longer discardable at the call site).
 *
 * PRECONDITION: the caller MUST already hold the project lock. This routes
 * through the LOCK-FREE {@link applyCompilePageWritesLocked}; every resolution
 * caller (compile's finalizeWiki, OKF refreshAfterImport, review approval) runs
 * under an already-held lock, so the self-locking path would self-deadlock.
 *
 * @param root - Absolute project root the writes are confined under.
 * @param changedSlugs - Slugs whose pages get outbound links re-resolved.
 * @param newSlugs - Newly-created slugs other pages get scanned for (inbound).
 * @param beforeApply - Optional write-ahead callback for floor-approved page IDs.
 * @returns Qualified IDs of the pages actually rewritten, excluding floor-skipped writes.
 */
export async function resolveAndApplyLinks(
  root: string,
  changedSlugs: string[],
  newSlugs: string[],
  beforeApply?: (pageIds: PageId[]) => Promise<void>,
): Promise<PageId[]> {
  return applyCompilePageWritesWithIdsLocked(root, await resolveLinks(root, changedSlugs, newSlugs), beforeApply);
}

/**
 * Build the rewritten-page write for an indexed page, or null when its body is unchanged.
 *
 * The replacement is a FUNCTION, not the string itself. `String.replace`
 * interprets `$&`, `` $` ``, `$'` and `$$` in a string replacement even when the
 * search argument is a plain string, and `linked` is page prose: a page reading
 * "the PID is $$" lost a `$`, and one containing a backtick-dollar had this
 * page's own frontmatter spliced into the middle of the sentence. Passing a
 * function suppresses that substitution entirely, so the rewritten body is
 * inserted verbatim.
 */
function rewritePage(page: LinkableTitle, content: string, linked: string, body: string): CompilePageWrite | null {
  if (linked === body) return null;
  return {
    namespace: TITLE_INDEX_NAMESPACE,
    slug: page.slug,
    body: content.replace(body, () => linked),
  };
}

/** Compute outbound [[wikilink]] rewrites for changed pages. */
async function resolveOutboundLinks(
  reads: LegacyLocalReads,
  titleIndex: LinkableTitle[],
  changedSlugs: string[],
): Promise<CompilePageWrite[]> {
  const writes: CompilePageWrite[] = [];
  for (const page of titleIndex) {
    if (!changedSlugs.includes(page.slug)) continue;
    const write = await linkPage(reads, page, titleIndex);
    if (write) writes.push(write);
  }
  return writes;
}

/** Compute inbound [[wikilink]] rewrites: scan every indexed page except the new ones for new concept titles. */
async function resolveInboundLinks(
  reads: LegacyLocalReads,
  titleIndex: LinkableTitle[],
  newSlugs: string[],
): Promise<CompilePageWrite[]> {
  if (newSlugs.length === 0) return [];
  const newTitles = titleIndex.filter((p) => newSlugs.includes(p.slug));
  if (newTitles.length === 0) return [];

  const writes: CompilePageWrite[] = [];
  for (const page of titleIndex) {
    // Skip the new pages themselves (not every changed page: an older changed
    // page is still scanned here, and its inbound body replaces its outbound one).
    if (newSlugs.includes(page.slug)) continue;
    const content = await readWikiPageContentOrWarnFrom(reads, CONCEPTS_DIR, page.slug);
    if (!content) continue;
    const { body } = parseFrontmatter(content);
    const write = rewritePage(page, content, addWikilinks(body, newTitles, page.title), body);
    if (write) writes.push(write);
  }
  return writes;
}

/** Compute the wikilink rewrite for a single page, or null when unchanged. */
async function linkPage(reads: LegacyLocalReads, page: LinkableTitle, titleIndex: LinkableTitle[]): Promise<CompilePageWrite | null> {
  const content = await readWikiPageContentOrWarnFrom(reads, CONCEPTS_DIR, page.slug);
  if (!content) return null;
  const { body } = parseFrontmatter(content);
  return rewritePage(page, content, addWikilinks(body, titleIndex, page.title), body);
}
