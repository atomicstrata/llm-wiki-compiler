/**
 * @file `llmwiki import --okf <dir> [--trusted] [--dry-run]`. Default: stage each OKF doc as an
 * imported review candidate (untrusted external knowledge stays gated behind review).
 * `--trusted`: write mapped pages straight into wiki/ (validated + collision-checked).
 *
 * This command is a thin CLI presentation layer over the output-free `runOkfImport`
 * core — it delegates all read/map/collision/stage/write logic and only formats the
 * returned report for the terminal.
 */
import { runOkfImport } from "../import/run.js";
import { LockUnavailableError } from "../import/run-errors.js";
import * as output from "../utils/output.js";
import type { OkfImportReport } from "../import/run.js";
export { isWritable } from "./import-core.js"; // preserve existing importers

/** CLI options for `import`. */
export interface ImportOptions { okf?: string; trusted?: boolean; dryRun?: boolean; }

/** Print a report's warnings, skips, per-page lines, and a one-line summary (CLI-only presentation). */
function printReport(report: OkfImportReport): void {
  for (const w of report.warnings) output.status("!", output.warn(w));
  for (const p of report.pages) output.status("+", `${p.slug} (${p.targetDirectory}) ← ${p.okfPath}`);
  for (const s of report.skipped) output.status("!", output.warn(`skip ${s.okfPath} — ${s.reason}`));
  const verb = report.mode === "written" ? "wrote" : report.mode === "dry-run" ? "would import" : "staged";
  output.status("+", output.success(`OKF import: ${verb} ${report.pages.length} page(s); skipped ${report.skipped.length}.`));
}

/** `llmwiki import --okf <dir> [--trusted] [--dry-run]`. */
export default async function importCommand(root: string, options: ImportOptions): Promise<void> {
  if (!options.okf) throw new Error("import: --okf <dir> is required");
  try {
    const report = await runOkfImport(root, options.okf, { trusted: options.trusted, dryRun: options.dryRun });
    printReport(report);
  } catch (err) {
    if (err instanceof LockUnavailableError) {
      output.status("!", output.error(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
