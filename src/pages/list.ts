/**
 * Path-safe page access primitives for the llmwiki in-process SDK.
 *
 * Exposes two public functions:
 *   - `getPage(root, ref)` — fetch a single page by directory + slug; returns
 *     the full `Page` shape (body included) or null when the file is absent.
 *   - `listPages(root, options)` — scan both page directories, read each page's
 *     body so wikilinks can be extracted, apply archive/orphan filters, sort,
 *     and return a cursor-paged slice.
 *
 * Design notes:
 *   - `links` are derived from the Markdown **body** via `extractWikilinkSlugs`,
 *     NOT from frontmatter.
 *   - `archived` and `orphaned` are boolean **frontmatter** flags.
 *   - `scanWikiPages` returns `{ slug, meta }` only (no body), so `listPages`
 *     always re-reads each file to extract body links even when `includeBody`
 *     is false.
 *   - Path safety is enforced at `getPage` entry via `assertSafeSlug`; symlink
 *     confinement is handled at a lower level by `scanWikiPages`.
 */

import path from "path";
import { scanWikiPages } from "../compiler/indexgen.js";
import { safeReadFile, parseFrontmatter } from "../utils/markdown.js";
import { extractWikilinkSlugs } from "../wiki/collect.js";
import { assertSafeSlug } from "../viewer/path-safety.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import { loadNonDefaultProfile, collectEntityPagesWithMessages } from "../profile/block.js";
import { toEntityPageView } from "../profile/types.js";
import type { EntityPageView } from "../profile/types.js";
import type { PageDirectory } from "../export/types.js";

export type { PageDirectory };

/** A reference to a specific page by its directory and slug. */
export interface PageRef {
  pageDirectory: PageDirectory;
  slug: string;
}

/** A fully-resolved in-memory representation of a single wiki page. */
export interface Page {
  slug: string;
  pageDirectory: PageDirectory;
  title: string;
  summary: string;
  tags: string[];
  /** Slugs of pages linked via `[[wikilinks]]` in the body. */
  links: string[];
  createdAt?: string;
  updatedAt?: string;
  /** True when frontmatter contains `orphaned: true`. */
  orphaned: boolean;
  /** True when frontmatter contains `archived: true`. */
  archived: boolean;
  /** Full markdown body, present only when `includeBody` is true or via `getPage`. */
  body?: string;
}

/** Options for filtering and paginating `listPages`. */
export interface ListPagesOptions {
  cursor?: string;
  limit?: number;
  includeBody?: boolean;
  includeArchived?: boolean;
  includeOrphaned?: boolean;
}

/**
 * Additive, non-default-profile entity-page block for `listPages`.
 *
 * Present ONLY for a non-default profile; for the built-in default it is
 * ABSENT (`result.profile === undefined`) so the default envelope is unchanged.
 * `entityPages` carries the PUBLIC `EntityPageView`s (project-relative `path`,
 * never an absolute `filePath`); each view's `body` is OMITTED when
 * `includeBody` is false (mirroring how the legacy `pages` block omits bodies).
 *
 * Entity-section pagination is deferred — every entity page is returned in one
 * block, regardless of the legacy `cursor`/`limit` (which still scope `pages`).
 */
export interface ListPagesProfileBlock {
  entityPages: EntityPageView[];
  /** Human-readable collector problems; present ONLY when non-empty. */
  problems?: string[];
}

/** Result returned by `listPages`. */
export interface ListPagesResult {
  pages: Page[];
  /** Opaque cursor for the next page; absent when the listing is exhausted. */
  cursor?: string;
  /**
   * Non-default profile entity pages, ADDITIVELY. ABSENT (undefined) for the
   * built-in default so the default envelope is byte-identical; the legacy
   * `pages` block stays scoped to concepts/queries in both cases.
   */
  profile?: ListPagesProfileBlock;
}

/** Maps each PageDirectory to its project-relative path. */
const DIR_NAMES: Record<PageDirectory, string> = {
  concepts: CONCEPTS_DIR,
  queries: QUERIES_DIR,
};

/** All page directories in listing order. */
const PAGE_DIRECTORIES: PageDirectory[] = ["concepts", "queries"];

/**
 * Build a Page from its directory, slug, parsed frontmatter, and body text.
 * Links are always extracted from the body so they reflect real wikilinks,
 * not any frontmatter list.
 */
function buildPage(
  dir: PageDirectory,
  slug: string,
  meta: Record<string, unknown>,
  body: string,
  includeBody: boolean,
): Page {
  return {
    slug,
    pageDirectory: dir,
    title: typeof meta.title === "string" ? meta.title : slug,
    summary: typeof meta.summary === "string" ? meta.summary : "",
    tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
    links: extractWikilinkSlugs(body),
    createdAt: typeof meta.createdAt === "string" ? meta.createdAt : undefined,
    updatedAt: typeof meta.updatedAt === "string" ? meta.updatedAt : undefined,
    orphaned: meta.orphaned === true,
    archived: meta.archived === true,
    ...(includeBody ? { body } : {}),
  };
}

/**
 * Fetch a single page by directory and slug.
 *
 * Throws `PathSafetyError` for unsafe slug values. Returns `null` when the
 * page does not exist on disk.
 *
 * @param root - Absolute path to the wiki workspace root.
 * @param ref - Which directory and slug to load.
 */
export async function getPage(root: string, ref: PageRef): Promise<Page | null> {
  assertSafeSlug(ref.slug);
  const filePath = path.join(root, DIR_NAMES[ref.pageDirectory], `${ref.slug}.md`);
  const content = await safeReadFile(filePath);
  if (!content) return null;
  const { meta, body } = parseFrontmatter(content);
  return buildPage(ref.pageDirectory, ref.slug, meta, body, true);
}

/**
 * List pages from both wiki directories with optional filtering and cursor
 * pagination.
 *
 * Pages are sorted by `(pageDirectory, slug)` before slicing. Bodies are
 * omitted by default; pass `includeBody: true` to include them. Orphaned
 * and archived pages are excluded by default; pass the corresponding flag
 * to include them.
 *
 * @param root - Absolute path to the wiki workspace root.
 * @param options - Filtering, pagination, and inclusion options.
 */
export async function listPages(
  root: string,
  options: ListPagesOptions = {},
): Promise<ListPagesResult> {
  const all = await collectPages(root, options);
  all.sort(
    (a, b) =>
      a.pageDirectory.localeCompare(b.pageDirectory) || a.slug.localeCompare(b.slug),
  );
  const result = paginate(all, options);
  const profile = await collectProfileBlock(root, options.includeBody === true);
  return profile ? { ...result, profile } : result;
}

/**
 * For a NON-DEFAULT profile only, build the additive `profile` block from the
 * content-carrying entity collector. Returns `undefined` for the built-in
 * default so the legacy envelope is unchanged — gated through the shared
 * {@link loadNonDefaultProfile} primitive, exactly as `status` does.
 *
 * Honors `includeBody`: each view's `body` is OMITTED (key absent) when bodies
 * are not requested, mirroring how the legacy `pages` block omits bodies. Maps
 * the internal `EntityPage` to the public `EntityPageView` so the absolute
 * `filePath` never reaches the surface.
 */
async function collectProfileBlock(
  root: string,
  includeBody: boolean,
): Promise<ListPagesProfileBlock | undefined> {
  const loaded = await loadNonDefaultProfile(root);
  if (loaded === undefined) return undefined;
  const { pages, messages } = await collectEntityPagesWithMessages(root, loaded);
  const entityPages = pages.map((page) => toEntityPageView(page, includeBody));
  return {
    entityPages,
    ...(messages.length > 0 ? { problems: messages } : {}),
  };
}

/**
 * Read every page from both directories, applying the archive/orphan filters.
 * Bodies are always read so wikilinks can be extracted; they are only retained
 * on the returned Page when `includeBody` is set.
 */
async function collectPages(root: string, options: ListPagesOptions): Promise<Page[]> {
  const all: Page[] = [];
  for (const dir of PAGE_DIRECTORIES) {
    const dirPath = path.join(root, DIR_NAMES[dir]);
    for (const { slug, meta } of await scanWikiPages(dirPath)) {
      const content = await safeReadFile(path.join(dirPath, `${slug}.md`));
      const { body } = parseFrontmatter(content);
      const page = buildPage(dir, slug, meta, body, options.includeBody === true);
      if (page.orphaned && !options.includeOrphaned) continue;
      if (page.archived && !options.includeArchived) continue;
      all.push(page);
    }
  }
  return all;
}

/**
 * Slice an already-sorted page list into a cursor-paged result. A non-positive
 * or absent limit is treated as unbounded (avoids a `limit: 0` empty-slice loop);
 * a non-integer or negative cursor is rejected rather than silently recycled.
 */
function paginate(all: Page[], options: ListPagesOptions): ListPagesResult {
  const offset = options.cursor !== undefined ? Number(options.cursor) : 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`invalid listPages cursor: ${options.cursor}`);
  }
  const limit = options.limit && options.limit > 0 ? options.limit : all.length;
  const slice = all.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  const cursor = nextOffset < all.length ? String(nextOffset) : undefined;
  return cursor !== undefined ? { pages: slice, cursor } : { pages: slice };
}
