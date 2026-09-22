/**
 * Commander action for `llmwiki lint`.
 *
 * Runs rule-based quality checks against the wiki without any LLM calls.
 * Prints colored diagnostics grouped by severity and exits with code 1
 * if any errors are found.
 */

import { lint, lintBothViews } from "../linter/index.js";
import type { TieredLintReportV1 } from "../linter/tiers.js";
import { writeLintCache } from "../linter/cache.js";
import * as output from "../utils/output.js";
import type { LintResult } from "../linter/types.js";
import { loadSchema } from "../schema/index.js";
import { planLintFixes } from "../linter/fix-plan.js";
import { lintFixProposeCommand } from "./lint-fix-propose.js";

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
/** Options for {@link lintCommand}. */
export interface LintCommandOptions {
  /** Preview §4.6's deterministic repairs as concrete edits; write nothing. */
  fixPreview?: boolean;
  /**
   * Propose the nth deterministic fix (as `--fix-preview` numbers them) as a
   * review candidate the operator applies with `review approve`. Writes nothing
   * to `wiki/`; a target changed since the proposal is refused at approval.
   */
  fixPropose?: number;
  /**
   * Group findings by the KIND of claim each makes, and exit non-zero only for
   * deterministic errors. Off by default: the flat report and its exit code are
   * unchanged for every existing caller.
   */
  tiered?: boolean;
}

/** Print one tier under a heading, or say it is empty. */
function printTier(heading: string, results: readonly LintResult[]): void {
  output.status("*", `${heading} (${results.length})`);
  for (const result of results) printResult(result);
}

/**
 * The tiered report (§4.6): the same findings, split by what kind of claim they
 * make, so a reader can tell what is BROKEN from what is merely an opinion or
 * out of date.
 *
 * The exit code follows the deterministic tier alone. A model judging a page
 * low-confidence is not grounds to fail, and neither is an index that needs
 * regenerating — under the flat report both do fail, which is what makes a
 * "0 errors" bar unreachable on a healthy wiki.
 */
function printTiered(tiered: TieredLintReportV1): void {
  printTier("BROKEN — deterministic failures", tiered.deterministic);
  printTier("JUDGEMENT — a model's assessment, not a fact", tiered.providerJudgement);
  printTier("STALE — derived views to regenerate, nothing is wrong", tiered.derivedView);
}

/** Pick the run for the requested flags: fix-propose, fix-preview, tiered, or flat. */
function selectLintRun(options: LintCommandOptions): () => Promise<void> {
  const proposeIndex = options.fixPropose;
  if (proposeIndex !== undefined) return () => runFixPropose(proposeIndex);
  if (options.fixPreview === true) return runFixPreview;
  return options.tiered === true ? runTiered : runFlat;
}

export default async function lintCommand(options: LintCommandOptions = {}): Promise<void> {
  output.header("Linting wiki");

  const schema = await loadSchema(process.cwd());
  const schemaSource = schema.loadedFrom ?? "defaults (no schema file)";
  output.status("i", output.dim(`Schema: ${schemaSource}`));

  return selectLintRun(options)();
}

/**
 * §4.6's other half: the deterministic repairs, PREVIEWED and never applied.
 *
 * The plan module existed and NOTHING imported it — correct-and-unreachable,
 * the same class as the packaging defects the parity run found. This is the
 * wiring: each fixable finding renders as the exact edit it would make, each
 * unfixable one as the recommendation §4.6 requires, and the command exits
 * without writing a byte either way.
 */
/** Stage one deterministic fix as a review candidate; exit non-zero on a bad index. */
async function runFixPropose(n: number): Promise<void> {
  const code = await lintFixProposeCommand(n);
  if (code !== 0) process.exit(code);
}

async function runFixPreview(): Promise<void> {
  const plans = await planLintFixes(process.cwd());
  if (plans.length === 0) {
    output.status("+", output.success("No broken wikilinks — nothing to fix."));
    return;
  }
  let fixNumber = 0;
  for (const plan of plans) {
    if (plan.kind === "fix") {
      // The number is the handle `--fix-propose <n>` takes; it counts FIXES
      // only (recommendations are not proposable), in this stable plan order.
      fixNumber += 1;
      output.status("~", output.info(`[${fixNumber}] ${plan.edit.file}:${plan.edit.line} [${plan.rule}]`));
      output.status(" ", output.dim(`  - ${plan.edit.from}`));
      output.status(" ", output.dim(`  + ${plan.edit.to}`));
    } else {
      output.status("!", output.warn(`${plan.file} [${plan.rule}] ${plan.advice}`));
    }
  }
  console.log();
  output.status("i", output.info(
    `${fixNumber} deterministic fix(es) previewed, ${plans.length - fixNumber} recommendation(s). ` +
      `Nothing was written. Propose fix N with \`llmwiki lint --fix-propose N\`.`,
  ));
}

/** The default path: one flat list and the pre-existing exit code. */
async function runFlat(): Promise<void> {
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

/** The `--tiered` path: one run, both views, deterministic-only exit code. */
async function runTiered(): Promise<void> {
  const { summary, tiered } = await lintBothViews(process.cwd(), "wiki-wide");
  printTiered(tiered);
  console.log();
  output.status("*", `${tiered.deterministicErrors} deterministic error(s) — the count that means something is wrong`);
  // The cache stays the flat summary every other reader already expects.
  await writeLintCache(process.cwd(), summary);
  if (tiered.deterministicErrors > 0) process.exit(1);
}
