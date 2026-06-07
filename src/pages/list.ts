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

/** Result returned by `listPages`. */
export interface ListPagesResult {
  pages: Page[];
  /** Opaque cursor for the next page; absent when the listing is exhausted. */
  cursor?: string;
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
    title: String(meta.title ?? slug),
    summary: String(meta.summary ?? ""),
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
  const all: Page[] = [];

  for (const dir of PAGE_DIRECTORIES) {
    const dirPath = path.join(root, DIR_NAMES[dir]);
    const scanned = await scanWikiPages(dirPath);

    for (const { slug, meta } of scanned) {
      const content = await safeReadFile(path.join(dirPath, `${slug}.md`));
      const { body } = parseFrontmatter(content);
      const page = buildPage(dir, slug, meta, body, options.includeBody === true);
      if (page.orphaned && !options.includeOrphaned) continue;
      if (page.archived && !options.includeArchived) continue;
      all.push(page);
    }
  }

  all.sort(
    (a, b) =>
      a.pageDirectory.localeCompare(b.pageDirectory) || a.slug.localeCompare(b.slug),
  );

  const offset = options.cursor ? Number(options.cursor) : 0;
  const limit = options.limit ?? all.length;
  const slice = all.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  const cursor = nextOffset < all.length ? String(nextOffset) : undefined;

  return cursor !== undefined ? { pages: slice, cursor } : { pages: slice };
}
