/**
 * CLI action handlers for `llmwiki eval` and its subcommands.
 *
 * Default action (evalCommand): runs the full or fast eval suite and outputs
 * a terminal table or JSON report, appending the result to history.jsonl.
 *
 * Subcommand handlers:
 *   evalCacheClearCommand  — delete the citation judgement cache
 *   evalCacheShowCommand   — print a cache summary
 *   evalReportCommand      — re-display the most recent eval report
 *   evalHistoryCommand     — show a trend table of past runs
 *   evalJudgementsCommand  — browse individual citation judgements with filters
 */

import { loadHistory, loadPreviousReport } from "../eval/stats.js";
import { runEval } from "../eval/index.js";
import {
  formatTerminalReport,
  formatJsonReport,
  formatHistoryTable,
  formatCacheShow,
  formatJudgementsDisplay,
} from "../eval/report.js";
import { clearCitationCache, loadCitationCache, summarizeCitationCache } from "../eval/cache.js";

interface EvalOptions {
  suite?: string;
  out?: string;
  sample?: string;
}

const DEFAULT_SAMPLE_SIZE = 20;

interface ResolvedEvalOptions {
  suite: "fast" | "full";
  sampleSize: number;
  outFormat: "terminal" | "json";
}

/**
 * Parse and validate --sample as a positive integer.
 * @throws if the value is not a positive integer (rejects 0, negatives, decimals, non-numeric).
 */
export function parseSampleSize(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--sample must be a positive integer (got "${raw}")`);
  }
  return n;
}

function resolveEvalOptions(options: EvalOptions): ResolvedEvalOptions {
  return {
    suite: options.suite === "full" ? "full" : "fast",
    sampleSize: parseSampleSize(options.sample ?? String(DEFAULT_SAMPLE_SIZE)),
    outFormat: options.out === "json" ? "json" : "terminal",
  };
}

/**
 * Run the eval harness against the current project.
 * @param options - Parsed CLI options.
 */
export default async function evalCommand(options: EvalOptions = {}): Promise<void> {
  const root = process.cwd();
  const { suite, sampleSize, outFormat } = resolveEvalOptions(options);

  const report = await runEval(root, suite, sampleSize);

  const output = outFormat === "json" ? formatJsonReport(report) : formatTerminalReport(report);
  console.log(output);

  if (report.thresholdViolations.length > 0) {
    process.exit(1);
  }
}

/** Delete the citation judgement cache so all pairs are re-judged on the next full run. */
export async function evalCacheClearCommand(): Promise<void> {
  const deleted = await clearCitationCache(process.cwd());
  console.log(deleted ? "Citation cache cleared." : "No citation cache found.");
}

/** Print a summary of cached citation judgements (score distribution + per-page counts). */
export async function evalCacheShowCommand(): Promise<void> {
  const judgements = await loadCitationCache(process.cwd());
  const summary = summarizeCitationCache(judgements);
  console.log(formatCacheShow(judgements, summary));
}

interface ReportOptions { out?: string }

/** Re-display the most recent eval report from history without running a new evaluation. */
export async function evalReportCommand(options: ReportOptions = {}): Promise<void> {
  const report = await loadPreviousReport(process.cwd());
  if (!report) {
    console.log("No eval history found. Run `llmwiki eval` to record the first run.");
    return;
  }
  const output = options.out === "json" ? formatJsonReport(report) : formatTerminalReport(report);
  console.log(output);
}

interface HistoryOptions { n?: string; out?: string }

/** Show a trend table of the last N eval runs from history.jsonl. */
export async function evalHistoryCommand(options: HistoryOptions = {}): Promise<void> {
  const n = parseInt(options.n ?? "10", 10);
  const reports = await loadHistory(process.cwd(), n);
  if (options.out === "json") {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }
  console.log(formatHistoryTable(reports));
}

interface JudgementsOptions { score?: string; page?: string; n?: string; out?: string }

function filterJudgements(judgements: Awaited<ReturnType<typeof loadCitationCache>>, options: JudgementsOptions) {
  let result = judgements;
  if (options.score !== undefined) result = result.filter((j) => j.score === parseInt(options.score!, 10));
  if (options.page) result = result.filter((j) => j.pageSlug === options.page);
  if (options.n !== undefined) result = result.slice(0, parseInt(options.n, 10));
  return result;
}

/** Browse cached citation judgements with optional filters by score, page, and count. */
export async function evalJudgementsCommand(options: JudgementsOptions = {}): Promise<void> {
  const judgements = filterJudgements(await loadCitationCache(process.cwd()), options);
  if (options.out === "json") {
    console.log(JSON.stringify(judgements, null, 2));
    return;
  }
  console.log(formatJudgementsDisplay(judgements));
}
