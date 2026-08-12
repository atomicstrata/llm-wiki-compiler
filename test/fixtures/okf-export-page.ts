/**
 * @file Shared ExportPage factory for OKF bundle-writer tests.
 *
 * The nested-export and output-dir-safety suites both build minimal in-memory
 * ExportPages to drive `buildOkfBundle`; the full required-field shape lives here
 * once rather than being copy-pasted (and re-flagged as a clone) into each suite.
 */
import type { ExportPage } from "../../src/export/types.js";

/** Options for {@link makeExportPage}; only `slug` is required. */
export interface ExportPageOptions {
  pageDirectory?: "concepts" | "queries";
  body?: string;
  okfPath?: string;
}

/** Build a complete ExportPage with sane defaults, optionally carrying an `x-okf` snapshot. */
export function makeExportPage(slug: string, opts: ExportPageOptions = {}): ExportPage {
  const { pageDirectory = "concepts", body = "b\n", okfPath } = opts;
  return {
    // No createdAt/updatedAt: they are optional, and a page that declares none
    // omits the keys rather than carrying an empty instant.
    slug, pageDirectory, title: slug, summary: "s", sources: [], tags: [],
    links: [], body, citations: [], freshnessStatus: "unverified", contradicted: false, archived: false,
    contentHash: "", sourceHashes: [], path: "", ...(okfPath ? { xOkf: { okfPath, originalFrontmatter: {} } } : {}),
  } as ExportPage;
}
