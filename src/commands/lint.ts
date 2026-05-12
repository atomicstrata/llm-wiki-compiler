/**
 * Commander action for `llmwiki lint`.
 *
 * Runs rule-based quality checks against the wiki without any LLM calls.
 * Prints colored diagnostics grouped by severity and exits with code 1
 * if any errors are found.
 */

import { lint } from "../linter/index.js";
import { writeLintCache } from "../linter/cache.js";
import * as output from "../utils/output.js";
import type { LintResult } from "../linter/types.js";
import { loadSchema } from "../schema/index.js";

/** Map severity levels to output formatting functions. */
const SEVERITY_FORMATTERS: Record<LintResult["severity"], (text: string) => string> = {
  error: output.error,
  warning: output.warn,
  info: output.info,
};

/** Map severity levels to display icons. */
const SEVERITY_ICONS: Record<LintResult["severity"], string> = {
  error: "x",
  warning: "!",
  info: "i",
};

/** Print a single lint result with colored output. */
function printResult(result: LintResult): void {
  const formatter = SEVERITY_FORMATTERS[result.severity];
  const icon = SEVERITY_ICONS[result.severity];
  const location = result.line ? `${result.file}:${result.line}` : result.file;
  output.status(icon, `${formatter(result.severity)} ${output.dim(location)} ${result.message}`);
}

/**
 * Run the lint command: execute all rules and print results.
 * Exits with code 1 if any errors are found.
 */
export default async function lintCommand(): Promise<void> {
  output.header("Linting wiki");

  const schema = await loadSchema(process.cwd());
  const schemaSource = schema.loadedFrom ?? "defaults (no schema file)";
  output.status("i", output.dim(`Schema: ${schemaSource}`));

  const summary = await lint(process.cwd());

  for (const result of summary.results) {
    printResult(result);
  }

  console.log();
  const summaryLine = [
    output.error(`${summary.errors} error(s)`),
    output.warn(`${summary.warnings} warning(s)`),
    output.info(`${summary.info} info`),
  ].join(", ");
  output.status("*", summaryLine);

  await writeLintCache(process.cwd(), summary);

  if (summary.errors > 0) {
    process.exit(1);
  }
}
