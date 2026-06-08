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
 */

import path from "path";
import { safeReadFile, parseFrontmatter } from "../utils/markdown.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";

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
 * Locate a page by slug across the priority-ordered page directories,
 * skipping orphaned entries to match the query pipeline's behaviour.
 *
 * @param root - Absolute path to the wiki workspace root.
 * @param slug - Page slug without the `.md` extension.
 * @returns The parsed page record, or `null` if not found or orphaned.
 */
export async function readPageRecord(root: string, slug: string): Promise<PageRecord | null> {
  for (const dir of PAGE_DIRS) {
    const content = await safeReadFile(path.join(root, dir, `${slug}.md`));
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
