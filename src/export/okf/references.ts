/**
 * @file Determine which source files must be copied into the bundle's references/ subdir.
 *
 * Only files that appear in at least one page's citation list are included,
 * ensuring the references/ directory stays minimal and auditable.
 */
import type { ExportPage } from "../types.js";

/**
 * Collect the deduped set of cited source filenames across all pages.
 * These are the files that must be copied into the bundle's `references/` directory.
 *
 * @param pages - All pages in the export.
 * @returns Deduplicated array of source filenames (order is insertion order).
 */
export function collectReferenceFiles(pages: ExportPage[]): string[] {
  const files = new Set<string>();
  for (const page of pages) for (const c of page.citations ?? []) files.add(c.file);
  return [...files];
}
