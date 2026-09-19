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
 *
 * A NON-DEFAULT profile's typed entity pages go through
 * {@link decorateEntityPages} instead, which reuses the SAME decoration
 * primitives over the shared `collectEntityPages` output rather than opening a
 * second collector.
 */

import { collectRawWikiPages, extractWikilinkSlugs, extractWikilinkTargets } from "../wiki/collect.js";
import type { RawWikiPage } from "../wiki/collect.js";
import { extractClaimCitations, slugify } from "../utils/markdown.js";
import type { DefaultViewerPage, PageId, ViewerPage, ViewerPageId, ViewerWarning } from "./types.js";
import type { PageDirectory } from "../export/types.js";
import type { EntityPage } from "../profile/types.js";
import type { PageFreshness } from "../freshness/types.js";

/**
 * Minimal page shape `resolveBareSlug` needs to find a target. Accepts the
 * widened `ViewerPageId`/directory so the whole snapshot page list can be passed
 * without filtering; only `concepts`/`queries` entries are ever matched, and
 * {@link defaultPageId} re-narrows a match to its concrete `PageId`.
 */
type PageIndexEntry = {
  id: ViewerPageId;
  pageDirectory: ViewerPage["pageDirectory"];
  slug: string;
  /** Declared frontmatter aliases, used as a resolution fallback after exact slug. */
  aliases?: readonly string[];
};

/**
 * Build the decorated page list for a project root. Each `ViewerPage`
 * carries its namespaced id, resolved outgoing links, citations, and any
 * `ViewerWarning` objects derived from the underlying `parseStatus` flags.
 * Returns pages in collector order (concepts then queries).
 */
export async function collectViewerPages(root: string): Promise<DefaultViewerPage[]> {
  const raw = await collectRawWikiPages(root);
  return decoratePages(raw);
}

/**
 * Decorate a NON-DEFAULT profile's typed entity pages into `ViewerPage`s, so the
 * envelope, `/api/page/<entityType>/<slug>` and search see them the way they see
 * default pages. Input comes from the SHARED `collectEntityPages` (already
 * filtered to the profile-VALID pages by the caller) — this layer adds only the
 * decoration, never a second read of disk.
 *
 * Outgoing wikilinks resolve against `defaultPages` alone, which is complete
 * rather than a shortcut: {@link resolveBareSlug} matches `concepts`/`queries`
 * targets only, so a typed page can never BE a wikilink target and widening the
 * index would resolve nothing extra.
 *
 * @param entityPages - Profile-valid typed entity pages, with their content.
 * @param defaultPages - The default page list, used as the wikilink index.
 * @returns One decorated `ViewerPage` per typed entity page, in input order.
 */
export function decorateEntityPages(
  entityPages: ReadonlyArray<EntityPage>,
  defaultPages: ReadonlyArray<PageIndexEntry>,
): ViewerPage[] {
  return entityPages.map((entity) => {
    const page = buildEntityPageShell(entity);
    page.outgoingLinks = resolveBareSlugList(extractWikilinkSlugs(page.body), defaultPages);
    return page;
  });
}

/**
 * Resolve a bare-slug wikilink target to a namespaced `PageId`. The
 * precedence rule (concepts before queries) matches the spec and is the
 * same logic used for both per-page outgoing links and `/api/index` link
 * resolution; exporting it here keeps callers from re-implementing the
 * order and accidentally diverging.
 *
 * Resolution runs once per wikilink occurrence — ~14k times on a 2356-page
 * wiki — so it reads a slug index built once per page list ({@link slugIndexFor})
 * instead of scanning the page list four times per link. Within each bucket the
 * first page in list order wins, preserving the previous `.find()` semantics.
 */
export function resolveBareSlug(
  slug: string,
  pages: ReadonlyArray<PageIndexEntry>,
): PageId | null {
  if (slug.length === 0) return null;
  const index = slugIndexFor(pages);
  const concept = index.conceptBySlug.get(slug);
  if (concept) return defaultPageId("concepts", concept);
  const query = index.queryBySlug.get(slug);
  if (query) return defaultPageId("queries", query);
  // Alias fallback: a page whose declared aliases slugify to this target. An
  // exact slug match always wins (above) so a real page is never shadowed by
  // another page's alias; concepts still take precedence over queries.
  const conceptAlias = index.conceptByAlias.get(slug);
  if (conceptAlias) return defaultPageId("concepts", conceptAlias);
  const queryAlias = index.queryByAlias.get(slug);
  if (queryAlias) return defaultPageId("queries", queryAlias);
  return null;
}

/** Four first-wins lookup tables covering the resolution precedence rule. */
interface PageSlugIndex {
  conceptBySlug: Map<string, PageIndexEntry>;
  queryBySlug: Map<string, PageIndexEntry>;
  conceptByAlias: Map<string, PageIndexEntry>;
  queryByAlias: Map<string, PageIndexEntry>;
}

/**
 * Slug index cache keyed by the page-list identity.
 *
 * The wikilink parser resolves against one page list for the whole parse, so
 * one index per list is enough. Caching on the array itself (WeakMap) means the
 * index is rebuilt only when a caller passes a different list, and never leaks
 * once that list is garbage.
 */
const slugIndexCache = new WeakMap<ReadonlyArray<PageIndexEntry>, PageSlugIndex>();

/** Insert `entry` under `key` unless a page already claimed it (first wins). */
function claim(table: Map<string, PageIndexEntry>, key: string, entry: PageIndexEntry): void {
  if (key.length > 0 && !table.has(key)) table.set(key, entry);
}

/** Build the four lookup tables in one pass over the page list. */
function buildSlugIndex(pages: ReadonlyArray<PageIndexEntry>): PageSlugIndex {
  const index: PageSlugIndex = {
    conceptBySlug: new Map(),
    queryBySlug: new Map(),
    conceptByAlias: new Map(),
    queryByAlias: new Map(),
  };
  for (const page of pages) {
    const bySlug = page.pageDirectory === "queries" ? index.queryBySlug : index.conceptBySlug;
    const byAlias = page.pageDirectory === "queries" ? index.queryByAlias : index.conceptByAlias;
    claim(bySlug, page.slug, page);
    for (const alias of page.aliases ?? []) claim(byAlias, slugify(alias), page);
  }
  return index;
}

/** Slug index for this page list, built on first use and then reused. */
function slugIndexFor(pages: ReadonlyArray<PageIndexEntry>): PageSlugIndex {
  let index = slugIndexCache.get(pages);
  if (!index) {
    index = buildSlugIndex(pages);
    slugIndexCache.set(pages, index);
  }
  return index;
}

/**
 * The concrete `PageId` of a matched DEFAULT page. `directory` is the literal
 * the caller just matched on, so this composes the SAME string
 * {@link buildPageShell} minted for `entry.id` — it just carries the narrow
 * `PageId` type that the widened index entry has given up.
 */
function defaultPageId(directory: PageDirectory, entry: PageIndexEntry): PageId {
  return `${directory}/${entry.slug}`;
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
function decoratePages(raw: RawWikiPage[]): DefaultViewerPage[] {
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
function buildPageShell(page: RawWikiPage): DefaultViewerPage {
  const id: PageId = `${page.pageDirectory}/${page.slug}`;
  return {
    id,
    slug: page.slug,
    pageDirectory: page.pageDirectory,
    title: page.title ?? page.slug,
    filePath: page.filePath,
    frontmatter: page.frontmatter,
    body: page.body,
    aliases: readAliases(page.frontmatter),
    outgoingLinks: [],
    citations: extractClaimCitations(page.body),
    warnings: warningsFromParseStatus(page),
    // Placeholder: overwritten by attachFreshness() in buildViewerSnapshot.
    freshness: UNVERIFIED_FRESHNESS,
  };
}

/**
 * Build the `ViewerPage` shell for one typed entity page. `outgoingLinks` starts
 * empty and is filled by {@link decorateEntityPages} once the index is known.
 *
 * Three decorations a default page gets are deliberately NOT emitted here, in
 * each case because the underlying signal does not exist for a typed page rather
 * than because it was overlooked:
 *
 *   - `aliases` — a typed page is never a wikilink resolution target (see
 *     {@link resolveBareSlug}), so declaring aliases on it would resolve
 *     nothing; emitting the field would imply a path that does not exist.
 *   - `warnings` from `parseStatus` — `missing_frontmatter` / `missing_title`
 *     ask whether the page met the DEFAULT profile's frontmatter expectations.
 *     A typed page is bound by its profile's declared field contract instead,
 *     and a violation of THAT is already surfaced authoritatively as a
 *     `field-violation` problem (which also excludes the page). Re-deriving the
 *     default expectation would report a contract the page was never under.
 *     Body-level citation warnings ARE still appended, in `snapshot.ts`, since
 *     those are contract-independent. The starting list is empty rather than
 *     absent so every page carries the same array shape.
 *   - `danglingLinks` — that field exists only to synthesise wikilink ghost
 *     nodes, and typed pages reach the graph as typed nodes/relation edges, not
 *     through the wikilink graph.
 */
function buildEntityPageShell(page: EntityPage): ViewerPage {
  return {
    id: page.id,
    slug: page.slug,
    pageDirectory: page.entityType,
    entityType: page.entityType,
    title: page.title ?? page.slug,
    filePath: page.filePath,
    frontmatter: page.frontmatter,
    body: page.body,
    outgoingLinks: [],
    citations: extractClaimCitations(page.body),
    warnings: [],
    // Placeholder: overwritten by attachFreshness() in buildViewerSnapshot.
    freshness: UNVERIFIED_FRESHNESS,
  };
}

/** Default freshness placeholder — overwritten in the snapshot build. */
const UNVERIFIED_FRESHNESS: PageFreshness = {
  freshnessStatus: "unverified",
  contradicted: false,
  archived: false,
};

/** Read the `aliases` frontmatter field as a string list (empty when absent/malformed). */
function readAliases(frontmatter: Record<string, unknown>): string[] {
  const raw = frontmatter.aliases;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string");
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

