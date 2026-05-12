/**
 * Wiki page collector for the export subsystem.
 *
 * Thin wrapper over `src/wiki/collect.ts::collectRawWikiPages()` that
 * applies export-specific filters (drop orphaned and untitled pages) and
 * decorates each surviving record with the export-facing fields (summary,
 * sources, tags, timestamps, link slugs). The wikilink extraction regex
 * and slug-normalization helper live in `src/wiki/collect.ts` so both
 * export and viewer callers share one source.
 */

import { collectRawWikiPages, extractWikilinkSlugs } from "../wiki/collect.js";
import type { RawWikiPage } from "../wiki/collect.js";
import type { ExportPage } from "./types.js";

export { extractWikilinkSlugs };

/**
 * Normalize a kept page into the shape every export writer consumes.
 * Caller is responsible for filtering out records that fail the export
 * gate (orphaned, untitled, unreadable).
 */
function toExportPage(raw: RawWikiPage): ExportPage {
  const meta = raw.frontmatter;
  return {
    title: raw.title as string,
    slug: raw.slug,
    pageDirectory: raw.pageDirectory,
    summary: typeof meta.summary === "string" ? meta.summary : "",
    sources: Array.isArray(meta.sources)
      ? (meta.sources as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
    tags: Array.isArray(meta.tags)
      ? (meta.tags as unknown[]).filter((t): t is string => typeof t === "string")
      : [],
    createdAt: typeof meta.createdAt === "string" ? meta.createdAt : new Date().toISOString(),
    updatedAt: typeof meta.updatedAt === "string" ? meta.updatedAt : new Date().toISOString(),
    links: extractWikilinkSlugs(raw.body),
    body: raw.body,
  };
}

/**
 * Collect all exportable wiki pages from `wiki/concepts/` and `wiki/queries/`.
 * Drops orphaned and untitled records — those are diagnosed by the viewer,
 * not exported. Returns the surviving pages sorted by title.
 */
export async function collectExportPages(root: string): Promise<ExportPage[]> {
  const raw = await collectRawWikiPages(root);
  const kept = raw.filter((page) => page.parseStatus.hasTitle && !page.parseStatus.orphaned);
  const pages = kept.map(toExportPage);
  pages.sort((a, b) => a.title.localeCompare(b.title));
  return pages;
}
