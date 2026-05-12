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

import { collectRawWikiPages, extractWikilinkSlugs } from "../wiki/collect.js";
import type { RawWikiPage } from "../wiki/collect.js";
import { extractClaimCitations } from "../utils/markdown.js";
import type { PageId, ViewerPage, ViewerSnapshot, ViewerWarning } from "./types.js";

/**
 * Build the page list portion of a `ViewerSnapshot` from a project root.
 * Slice 2 will wrap this with project metadata, counts, and recent-pages
 * derivation; Slice 1 returns just the pages array and the root/timestamp.
 */
export async function collectViewerPages(root: string): Promise<ViewerSnapshot> {
  const raw = await collectRawWikiPages(root);
  const pages = decoratePages(raw);
  return { root, generatedAt: new Date().toISOString(), pages };
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
  snapshot: { pages: ReadonlyArray<{ id: PageId; pageDirectory: ViewerPage["pageDirectory"]; slug: string }> },
): PageId | null {
  if (slug.length === 0) return null;
  const concept = snapshot.pages.find((p) => p.pageDirectory === "concepts" && p.slug === slug);
  if (concept) return concept.id;
  const query = snapshot.pages.find((p) => p.pageDirectory === "queries" && p.slug === slug);
  if (query) return query.id;
  return null;
}

/**
 * Two-pass decoration: build the namespaced id/title/warnings shell for
 * every page first, then resolve wikilink targets against the completed
 * shell. Single-pass would let a page miss links to pages later in the
 * list; the index has to be complete before resolution begins.
 */
function decoratePages(raw: RawWikiPage[]): ViewerPage[] {
  const shells = raw.map(buildPageShell);
  const indexForResolver = { pages: shells };
  for (const page of shells) {
    const targets = extractWikilinkSlugs(page.body);
    page.outgoingLinks = collectResolvedLinks(targets, indexForResolver);
  }
  return shells;
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

/**
 * Resolve a list of bare-slug wikilink targets and deduplicate the
 * resulting `PageId`s while preserving first-occurrence order. Unresolved
 * targets are dropped here; the renderer is responsible for marking
 * unresolved wikilinks as `data-missing="true"` from the original body
 * text, not from this array.
 */
function collectResolvedLinks(
  targets: string[],
  index: { pages: ReadonlyArray<ViewerPage> },
): PageId[] {
  const seen = new Set<PageId>();
  const ordered: PageId[] = [];
  for (const target of targets) {
    const resolved = resolveBareSlug(target, index);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      ordered.push(resolved);
    }
  }
  return ordered;
}
