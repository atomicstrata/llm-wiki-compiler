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
 * `[[argo-cd-image-update-ownership-model|Argo CD]]`. Rendered output is
 * therefore identical, and the worst a mistake here can do is point a link at
 * the wrong page — it can never alter prose.
 *
 * Only an unambiguous prefix match is repaired. A slug that prefixes two pages
 * is left alone rather than guessed at, and so is one that prefixes none: a link
 * to a concept the wiki genuinely lacks is a signal about what is missing, not
 * noise to be hidden.
 */

import path from "path";
import { parseFrontmatter } from "../utils/markdown.js";
import { collectAllPages } from "../linter/rules-shared.js";
import { listLinkResolvablePendingSlugs } from "./candidate-read.js";
import { applyCompilePageWritesLocked } from "./compile-write.js";
import type { CompilePageNamespace, CompilePageWrite } from "./compile-write.js";
import { QUERIES_DIR } from "../utils/constants.js";
import * as output from "../utils/output.js";

/** `[[target]]` and `[[target|alias]]`, capturing everything between brackets. */
const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g;

/** Separator joining slug words, and therefore the prefix boundary. */
const SLUG_SEPARATOR = "-";

/**
 * Shortest link slug considered for repair. Below this a slug prefixes pages it
 * has nothing to do with — `[[a]]` would claim `a-b-c` — and the uniqueness
 * check cannot tell that apart from a real abbreviation.
 */
const MIN_REPAIRABLE_SLUG_LENGTH = 3;

/**
 * Slugify a wikilink target the same way page filenames are slugified, so a
 * link and the page it names compare on equal terms.
 */
function slugifyTarget(target: string): string {
  return target
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, SLUG_SEPARATOR)
    .replace(/-+/g, SLUG_SEPARATOR)
    .replace(/^-|-$/g, "");
}

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
  const next = body.replace(WIKILINK_PATTERN, (match, inner: string) => {
    const { target, alias } = splitWikilink(inner);
    const resolved = resolve(slugifyTarget(target));
    if (!resolved) return match;
    repaired += 1;
    return `[[${resolved}|${alias}]]`;
  });
  return { body: next, repaired };
}

/** Derive the compile namespace from a page's absolute file path. */
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
  const pages = await collectAllPages(root);
  if (pages.length === 0) return [];

  const slugs = pages.map((page) => path.basename(page.filePath, ".md").toLowerCase());
  const existing = new Set(slugs);
  const pending = await listLinkResolvablePendingSlugs(root);
  // A pending target resolves on its own when the candidate is approved, so
  // repointing it now would silently redirect the link away from the page the
  // author is about to publish.
  const resolve = (targetSlug: string): string | null =>
    existing.has(targetSlug) || pending.has(targetSlug)
      ? null
      : resolveUniquePrefix(targetSlug, slugs);

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
      body: page.content.replace(body, result.body),
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
 */
export async function repairAndApplyLinks(root: string): Promise<void> {
  await applyCompilePageWritesLocked(root, await repairLinks(root));
}
