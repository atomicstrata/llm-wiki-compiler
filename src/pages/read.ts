/**
 * Page-reading utilities for llmwiki.
 *
 * Exposes `readPageRecord`, which locates a wiki page by slug across the
 * priority-ordered page directories (concepts first, then queries), parses
 * its frontmatter, and returns a structured `PageRecord`. Orphaned pages are
 * silently skipped to match the query pipeline's behaviour.
 *
 * This module is shared between the MCP tool layer and the in-process SDK so
 * both consumers work from identical read semantics.
 *
 * Slugs reach these readers from MCP callers, so they are untrusted. Every read
 * goes through {@link readPageContent}, which accepts a slug only as a single
 * filename component and confines the resolved file to its page directory, so
 * neither `../` segments nor a symlink can read a file outside that directory.
 */

import { parseFrontmatter } from "../utils/markdown.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import { readConfinedWikiPage } from "../compiler/confined-wiki-read.js";

/** Directories searched (in priority order) when resolving a page slug. */
const PAGE_DIRS = [CONCEPTS_DIR, QUERIES_DIR];

/** Shape returned by readPageRecord and search_pages for each matching page. */
export interface PageRecord {
  slug: string;
  title: string;
  summary: string;
  body: string;
}

/**
 * Is `slug` a single filename component? Page slugs may contain Unicode,
 * spaces, `#` and `%`, so this rejects only what could name another directory:
 * an empty value, a path separator, or a NUL byte.
 *
 * @param slug - Candidate page slug, without the `.md` extension.
 * @returns True when `<slug>.md` names a file directly inside one directory.
 */
function isPageSlugComponent(slug: string): boolean {
  return slug.length > 0 && !/[/\\\0]/.test(slug);
}

/**
 * Read `<root>/<dir>/<slug>.md`, confined to `<root>/<dir>`. A slug that is not
 * a single filename component, a missing file, and a file whose real path
 * leaves the directory (a symlink to elsewhere) all read as absent.
 *
 * @param root - Absolute path to the wiki workspace root.
 * @param dir - Project-relative page directory, e.g. `wiki/concepts`.
 * @param slug - Untrusted page slug, without the `.md` extension.
 * @returns The page's content, or `null` when it is absent or not readable here.
 */
export async function readPageContent(root: string, dir: string, slug: string): Promise<string | null> {
  if (!isPageSlugComponent(slug)) return null;
  const result = await readConfinedWikiPage(root, dir, slug);
  return "content" in result ? result.content : null;
}

/**
 * Locate a page by slug across the priority-ordered page directories,
 * skipping orphaned entries to match the query pipeline's behaviour.
 *
 * @param root - Absolute path to the wiki workspace root.
 * @param slug - Page slug without the `.md` extension.
 * @returns The parsed page record, or `null` if not found or orphaned.
 */
export async function readPageRecord(root: string, slug: string): Promise<PageRecord | null> {
  for (const dir of PAGE_DIRS) {
    const content = await readPageContent(root, dir, slug);
    if (!content) continue;

    const { meta, body } = parseFrontmatter(content);
    if (meta.orphaned) continue;

    return {
      slug,
      title: typeof meta.title === "string" ? meta.title : slug,
      summary: typeof meta.summary === "string" ? meta.summary : "",
      body: body.trim(),
    };
  }
  return null;
}
