/**
 * Viewer-facing page collector.
 *
 * Consumes the structural records produced by `src/wiki/collect.ts` and
 * decorates each one with the fields the HTTP server needs:
 *   - namespaced `id` (`concepts/<slug>` or `queries/<slug>`)
 *   - `outgoingLinks` resolved against the in-memory page list using the
 *     bare-slug precedence rule (concepts win over queries)
 *   - `citations` extracted via `extractClaimCitations`
 *   - stable `ViewerWarning` objects derived from `parseStatus` flags
 *
 * Unlike the export collector, this layer never drops a page: pages with
 * missing or malformed frontmatter are retained with a warning so users
 * can navigate to them and see what is wrong.
 */

import { collectRawWikiPages, extractWikilinkSlugs, extractWikilinkTargets } from "../wiki/collect.js";
import type { RawWikiPage } from "../wiki/collect.js";
import { extractClaimCitations } from "../utils/markdown.js";
import type { PageId, ViewerPage, ViewerWarning } from "./types.js";

/** Minimal page shape `resolveBareSlug` needs to find a target. */
type PageIndexEntry = { id: PageId; pageDirectory: ViewerPage["pageDirectory"]; slug: string };

/**
 * Build the decorated page list for a project root. Each `ViewerPage`
 * carries its namespaced id, resolved outgoing links, citations, and any
 * `ViewerWarning` objects derived from the underlying `parseStatus` flags.
 * Returns pages in collector order (concepts then queries).
 */
export async function collectViewerPages(root: string): Promise<ViewerPage[]> {
  const raw = await collectRawWikiPages(root);
  return decoratePages(raw);
}

/**
 * Resolve a bare-slug wikilink target to a namespaced `PageId`. The
 * precedence rule (concepts before queries) matches the spec and is the
 * same logic used for both per-page outgoing links and `/api/index` link
 * resolution; exporting it here keeps callers from re-implementing the
 * order and accidentally diverging.
 */
export function resolveBareSlug(
  slug: string,
  pages: ReadonlyArray<PageIndexEntry>,
): PageId | null {
  if (slug.length === 0) return null;
  const concept = pages.find((p) => p.pageDirectory === "concepts" && p.slug === slug);
  if (concept) return concept.id;
  const query = pages.find((p) => p.pageDirectory === "queries" && p.slug === slug);
  if (query) return query.id;
  return null;
}

/**
 * Resolve a list of bare-slug wikilink targets against an in-memory page
 * index and deduplicate the resulting `PageId`s while preserving first-
 * occurrence order. Unresolved targets are dropped.
 */
export function resolveBareSlugList(
  targets: string[],
  pages: ReadonlyArray<PageIndexEntry>,
): PageId[] {
  const seen = new Set<PageId>();
  const ordered: PageId[] = [];
  for (const target of targets) {
    const resolved = resolveBareSlug(target, pages);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      ordered.push(resolved);
    }
  }
  return ordered;
}

/**
 * Two-pass decoration: build the namespaced id/title/warnings shell for
 * every page first, then resolve wikilink targets against the completed
 * shell. Single-pass would let a page miss links to pages later in the
 * list; the index has to be complete before resolution begins.
 */
function decoratePages(raw: RawWikiPage[]): ViewerPage[] {
  const shells = raw.map(buildPageShell);
  for (const page of shells) {
    const slugTargets = extractWikilinkSlugs(page.body);
    const richTargets = extractWikilinkTargets(page.body);
    page.outgoingLinks = resolveBareSlugList(slugTargets, shells);
    page.danglingLinks = collectDanglingLinks(richTargets, shells);
  }
  return shells;
}

/**
 * Return targets from `targets` that `resolveBareSlug` could not find,
 * deduplicated by slug and in first-occurrence order.
 */
function collectDanglingLinks(
  targets: { slug: string; display: string }[],
  pages: ReadonlyArray<PageIndexEntry>,
): { slug: string; display: string }[] {
  const seen = new Set<string>();
  const dangling: { slug: string; display: string }[] = [];
  for (const t of targets) {
    if (resolveBareSlug(t.slug, pages) === null && !seen.has(t.slug)) {
      seen.add(t.slug);
      dangling.push(t);
    }
  }
  return dangling;
}

/**
 * Build the parts of a `ViewerPage` that do not need cross-page resolution
 * (id, title, citations, warnings). `outgoingLinks` starts empty and is
 * filled in once every shell is built.
 */
function buildPageShell(page: RawWikiPage): ViewerPage {
  const id: PageId = `${page.pageDirectory}/${page.slug}`;
  return {
    id,
    slug: page.slug,
    pageDirectory: page.pageDirectory,
    title: page.title ?? page.slug,
    filePath: page.filePath,
    frontmatter: page.frontmatter,
    body: page.body,
    outgoingLinks: [],
    citations: extractClaimCitations(page.body),
    warnings: warningsFromParseStatus(page),
  };
}

/**
 * Map the structural `parseStatus` flags from `src/wiki/collect.ts` into
 * stable viewer warnings. Multiple conditions on one page produce
 * multiple warnings; the order here is the order they appear on the
 * page's `warnings[]`.
 */
function warningsFromParseStatus(page: RawWikiPage): ViewerWarning[] {
  const warnings: ViewerWarning[] = [];
  if (!page.parseStatus.hasFrontmatterBlock) {
    warnings.push({
      code: "missing_frontmatter",
      message: `Page "${page.slug}" has no frontmatter block.`,
    });
  } else if (page.parseStatus.malformedFrontmatter) {
    warnings.push({
      code: "malformed_frontmatter",
      message: `Page "${page.slug}" has malformed YAML frontmatter.`,
    });
  }
  if (!page.parseStatus.hasTitle) {
    warnings.push({
      code: "missing_title",
      message: `Page "${page.slug}" has no frontmatter title; displaying slug.`,
    });
  }
  return warnings;
}

