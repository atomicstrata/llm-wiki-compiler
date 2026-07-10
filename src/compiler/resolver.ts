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
 */

import { readdir } from "fs/promises";
import path from "path";
import { existsSync } from "fs";
import { parseFrontmatter } from "../utils/markdown.js";
import { readWikiPageContentOrWarn } from "./confined-wiki-read.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import { applyCompilePageWritesLocked } from "./compile-write.js";
import type { CompilePageNamespace, CompilePageWrite } from "./compile-write.js";
import * as output from "../utils/output.js";

interface PageInfo {
  /** Project root, carried so per-page reads/writes stay confined to `wiki/concepts`. */
  root: string;
  slug: string;
  title: string;
  filePath: string;
}

/**
 * Build an index of all wiki page titles from the concepts directory. Each page
 * is read through the confined helper, so a symlinked entry whose target escapes
 * `wiki/concepts` is dropped (warned, skipped) and never enters the title index
 * (so its bytes can never be re-emitted into a rewritten page).
 */
async function buildTitleIndex(root: string): Promise<PageInfo[]> {
  const conceptsDir = path.join(root, CONCEPTS_DIR);
  if (!existsSync(conceptsDir)) return [];

  const files = await readdir(conceptsDir);
  const pages: PageInfo[] = [];

  for (const file of files) {
    if (!file.endsWith(".md")) continue;

    const slug = file.replace(/\.md$/, "");
    const content = await readWikiPageContentOrWarn(root, CONCEPTS_DIR, slug);
    if (!content) continue;
    const { meta } = parseFrontmatter(content);

    if (meta.title && typeof meta.title === "string" && !meta.orphaned) {
      pages.push({
        root,
        slug,
        title: meta.title,
        filePath: path.join(conceptsDir, file),
      });
    }
  }

  return pages;
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
function isLinkablePosition(text: string, start: number, end: number): boolean {
  if (isInsideWikilink(text, start)) return false;
  if (isInsideCitation(text, start)) return false;
  return isWordBoundary(text, start, end);
}

/**
 * Add [[wikilinks]] to a page's body for any title mentions.
 * Skips already-linked text and non-word-boundary matches.
 */
function addWikilinks(body: string, titles: PageInfo[], selfTitle: string): string {
  let result = body;
  const selfLower = selfTitle.toLowerCase();

  for (const page of titles) {
    if (page.title.toLowerCase() === selfLower) continue;

    const matches = findTitleMatches(result, page.title);

    // Process matches in reverse to preserve positions
    for (const m of matches.reverse()) {
      if (!isLinkablePosition(result, m.start, m.end)) continue;
      result = result.slice(0, m.start) + `[[${page.slug}|${page.title}]]` + result.slice(m.end);
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
 * 2. Inbound: ALL pages get scanned for mentions of newly created titles.
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
  const titleIndex = await buildTitleIndex(root);
  if (titleIndex.length === 0) return [];

  // Pass 1 (outbound) on changed pages, then Pass 2 (inbound) on all pages,
  // de-duplicated by slug so a page changed in both passes is written once with
  // the latest body (inbound supersedes outbound for the same page).
  const writes = new Map<string, CompilePageWrite>();
  for (const write of await resolveOutboundLinks(titleIndex, changedSlugs)) {
    writes.set(write.slug, write);
  }
  for (const write of await resolveInboundLinks(titleIndex, newSlugs)) {
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
 */
export async function resolveAndApplyLinks(
  root: string,
  changedSlugs: string[],
  newSlugs: string[],
): Promise<void> {
  await applyCompilePageWritesLocked(root, await resolveLinks(root, changedSlugs, newSlugs));
}

/** Derive the compile namespace from a page's absolute file path. */
function namespaceForPath(filePath: string): CompilePageNamespace {
  const dir = path.dirname(filePath);
  if (dir.endsWith(QUERIES_DIR) || path.basename(dir) === path.basename(QUERIES_DIR)) {
    return "queries";
  }
  return "concepts";
}

/** Build the rewritten-page write for a PageInfo, or null when its body is unchanged. */
function rewritePage(page: PageInfo, content: string, linked: string, body: string): CompilePageWrite | null {
  if (linked === body) return null;
  return {
    namespace: namespaceForPath(page.filePath),
    slug: page.slug,
    body: content.replace(body, linked),
  };
}

/** Compute outbound [[wikilink]] rewrites for changed pages. */
async function resolveOutboundLinks(
  titleIndex: PageInfo[],
  changedSlugs: string[],
): Promise<CompilePageWrite[]> {
  const writes: CompilePageWrite[] = [];
  for (const page of titleIndex) {
    if (!changedSlugs.includes(page.slug)) continue;
    const write = await linkPage(page, titleIndex);
    if (write) writes.push(write);
  }
  return writes;
}

/** Compute inbound [[wikilink]] rewrites: scan ALL pages for new concept titles. */
async function resolveInboundLinks(
  titleIndex: PageInfo[],
  newSlugs: string[],
): Promise<CompilePageWrite[]> {
  if (newSlugs.length === 0) return [];
  const newTitles = titleIndex.filter((p) => newSlugs.includes(p.slug));
  if (newTitles.length === 0) return [];

  const writes: CompilePageWrite[] = [];
  for (const page of titleIndex) {
    // Skip pages already processed in the outbound pass.
    if (newSlugs.includes(page.slug)) continue;
    const content = await readWikiPageContentOrWarn(page.root, CONCEPTS_DIR, page.slug);
    if (!content) continue;
    const { body } = parseFrontmatter(content);
    const write = rewritePage(page, content, addWikilinks(body, newTitles, page.title), body);
    if (write) writes.push(write);
  }
  return writes;
}

/** Compute the wikilink rewrite for a single page, or null when unchanged. */
async function linkPage(page: PageInfo, titleIndex: PageInfo[]): Promise<CompilePageWrite | null> {
  const content = await readWikiPageContentOrWarn(page.root, CONCEPTS_DIR, page.slug);
  if (!content) return null;
  const { body } = parseFrontmatter(content);
  return rewritePage(page, content, addWikilinks(body, titleIndex, page.title), body);
}
