// src/export/okf/run.ts
/** @file Output-free OKF export core shared by CLI/SDK/MCP: collect pages + build the bundle, returning the written paths. */
import path from "path";
import { collectExportPages } from "../collect.js";
import { buildOkfBundle } from "./bundle.js";
import { EXPORT_DIR } from "../../utils/constants.js";

export interface OkfExportReport { outDir: string; writtenPaths: string[]; }

/** Export the wiki as an OKF bundle under `out` (default dist/exports/okf). Returns the bundle dir + every written path. */
export async function runOkfExport(root: string, opts: { out?: string } = {}): Promise<OkfExportReport> {
  const outDir = opts.out ?? path.join(root, EXPORT_DIR, "okf");
  const pages = await collectExportPages(root);
  const writtenPaths = await buildOkfBundle(root, pages, outDir);
  return { outDir, writtenPaths };
}
