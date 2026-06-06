/**
 * Commander action for `llmwiki lint`.
 *
 * Runs rule-based quality checks against the wiki without any LLM calls.
 * Prints colored diagnostics grouped by severity and exits with code 1
 * if any errors are found.
 */

import path from "path";
import { lint } from "../linter/index.js";
import { writeLintCache } from "../linter/cache.js";
import * as output from "../utils/output.js";
import type { LintResult, LintSummary } from "../linter/types.js";
import { loadSchema } from "../schema/index.js";
import { appendLog, formatWikilinkList } from "../utils/activity-log.js";

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
  await journalLintPass(process.cwd(), summary);

  if (summary.errors > 0) {
    process.exit(1);
  }
}

/** Distinct page slugs touched by error/warning diagnostics, in first-seen order. */
function flaggedPageSlugs(results: LintResult[]): string[] {
  const slugs: string[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    if (result.severity === "info") continue;
    const slug = path.basename(result.file, ".md");
    if (seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
  }
  return slugs;
}

/**
 * Journal the lint pass to log.md. Lives in the CLI command (not the core
 * lint() function) so the MCP `lint_wiki` tool stays read-only as documented.
 */
async function journalLintPass(root: string, summary: LintSummary): Promise<void> {
  const heading =
    `${summary.errors} error(s), ${summary.warnings} warning(s), ${summary.info} info`;
  const flagged = flaggedPageSlugs(summary.results);
  const details = flagged.length > 0 ? [`Flagged: ${formatWikilinkList(flagged)}`] : [];
  await appendLog(root, "lint", heading, { details });
}
