// src/export/okf/run.ts
/** @file Output-free OKF export core shared by CLI/SDK/MCP: collect pages + build the bundle, returning the written paths. */
import path from "path";
import { collectExportPagesFrom, diskExportPageSources, type ExportPageSources } from "../collect.js";
import { buildOkfBundleFrom, diskOkfBundleSources, type OkfBundleSources } from "./bundle.js";
import { EXPORT_DIR } from "../../utils/constants.js";
import { diskJournalReadSources, type JournalReadSources } from "../../trust/journal-classify.js";
import { journalHealthWarningFrom } from "../../trust/journal-health-warning.js";

export interface OkfExportReport { outDir: string; writtenPaths: string[]; warnings: string[]; }

/** Export the wiki as an OKF bundle under `out` (default dist/exports/okf). Returns the bundle dir, every written path, and any non-fatal warnings (e.g. cited sources not bundled). Output-free — warnings are data, not prints. */
export async function runOkfExport(root: string, opts: { out?: string } = {}): Promise<OkfExportReport> {
  // `async` so that a throw while the disk sources are built REJECTS.
  return runOkfExportFrom(diskOkfExportSources(root), root, opts);
}

/**
 * Everything {@link runOkfExportFrom} reads and writes through: the export page
 * sources, the journal, and the bundle writer's sources. A narrow seam: not
 * `ProjectStore`, not a hosted or access-control contract. The output
 * directory is a local path the caller names, possibly outside the project.
 */
export interface OkfExportSources {
  pages: ExportPageSources;
  journal: JournalReadSources;
  bundle: OkfBundleSources;
}

/** LOCAL DISK. The OKF export sources for the project at `root`. Building them does no I/O. In no package index. */
export function diskOkfExportSources(root: string): OkfExportSources {
  return { pages: diskExportPageSources(root), journal: diskJournalReadSources(root), bundle: diskOkfBundleSources(root) };
}

/**
 * {@link runOkfExport} over {@link OkfExportSources}: THE ONE BODY. The default
 * output directory; the pages; the journal warning; then the bundle, whose own
 * warnings follow the journal's.
 */
export async function runOkfExportFrom(sources: OkfExportSources, root: string, opts: { out?: string } = {}): Promise<OkfExportReport> {
  const outDir = opts.out ?? path.join(root, EXPORT_DIR, "okf");
  // Timeline pages are regenerated from the sources' dates on every compile, so
  // they are not knowledge to carry between projects; the bundle holds concepts and queries.
  const pages = (await collectExportPagesFrom(sources.pages)).filter((page) => page.pageDirectory !== "timeline");
  const warnings: string[] = [];
  // Surface a pending/unavailable compile journal so an OKF-bundle consumer never
  // imports partial post-crash or tampered page bodies as a clean export. The
  // channel is `string[]`, so format the shared warning as `code: message`
  // (matching the other string surfaces). An ok journal adds nothing — parity-safe.
  const journal = await journalHealthWarningFrom(sources.journal);
  if (journal) warnings.push(`${journal.code}: ${journal.message}`);
  const writtenPaths = await buildOkfBundleFrom(sources.bundle, root, pages, outDir, (m) => warnings.push(m));
  return { outDir, writtenPaths, warnings };
}
