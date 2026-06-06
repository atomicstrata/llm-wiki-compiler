/**
 * Terminal and JSON formatters for the llmwiki eval harness.
 *
 * formatTerminalReport renders a box-drawing table with all metric families,
 * inline regression deltas (↑/↓), and threshold violations in red.
 * formatJsonReport serialises the raw EvalReport for machine consumption.
 */

import { bold, dim, error as colorError } from "../utils/output.js";
import type { EvalReport, EvalDelta, HealthRuleResult, CitationJudgement } from "./types.js";
import type { CacheSummary } from "./cache.js";

const BOX_WIDTH = 49;
const HORIZONTAL = "─".repeat(BOX_WIDTH);

function line(content = ""): string {
  return `│ ${content.padEnd(BOX_WIDTH - 2)} │`;
}

function top(): string {
  return `┌${HORIZONTAL}┐`;
}

function divider(): string {
  return `├${HORIZONTAL}┤`;
}

function bottom(): string {
  return `└${HORIZONTAL}┘`;
}

/** Format a signed delta as ↑/↓ string, or empty string if zero/absent. */
function fmtDelta(value: number | undefined): string {
  if (value === undefined || value === 0) return "";
  const abs = Math.abs(value).toFixed(1).replace(/\.0$/, "");
  return value > 0 ? dim(` (↑${abs})`) : dim(` (↓${abs})`);
}

/** Format a rule row with count and deduction. */
function ruleRow(rule: HealthRuleResult): string {
  if (rule.count === 0) return "";
  const label = `    ${rule.rule}:`;
  const right = `${rule.count}  (−${rule.deduction})`;
  const gap = BOX_WIDTH - 4 - label.length - right.length;
  return line(`${label}${" ".repeat(Math.max(1, gap))}${right}`);
}

function formatHealth(report: EvalReport, delta: EvalDelta | undefined): string[] {
  const scoreDelta = fmtDelta(delta?.healthScore);
  const rows = [
    line(),
    line(bold(`Structural Health:  ${report.health.score} / 100${scoreDelta}`)),
  ];
  for (const rule of report.health.rules) {
    const row = ruleRow(rule);
    if (row) rows.push(row);
  }
  return rows;
}

function formatCoverage(report: EvalReport, delta: EvalDelta | undefined): string[] {
  const cov = report.citationCoverage;
  const covDelta = fmtDelta(delta?.citationCoveragePercent);
  const precDelta = fmtDelta(delta?.citationPrecisionPercent);
  return [
    line(),
    line(bold(`Citation Coverage:  ${cov.coveragePercent.toFixed(0)}%${covDelta}`)),
    line(`  ${cov.citedParagraphs} / ${cov.totalProseParagraphs} prose paragraphs cited`),
    line(
      `  Precision: ${cov.precisionPercent.toFixed(0)}%${precDelta} (${cov.validCitations}/${cov.totalCitations} valid)`,
    ),
  ];
}

function formatSupport(report: EvalReport, delta: EvalDelta | undefined): string[] {
  const s = report.citationSupport;
  if (!s) return [];
  const meanDelta = fmtDelta(delta?.citationSupportMean);
  const pctOf = (n: number) =>
    s.sampledCount === 0 ? "—" : `${((n / s.sampledCount) * 100).toFixed(0)}%`;
  const rows = [
    line(),
    line(bold(`Citation Support (${s.sampledCount} sampled):`)),
    line(`  Mean score: ${s.meanScore.toFixed(2)} / 2.0${meanDelta}`),
    line(`  Fully supported:     ${s.fullySupported}  (${pctOf(s.fullySupported)})`),
    line(`  Partially supported: ${s.partiallySupported}  (${pctOf(s.partiallySupported)})`),
    line(`  Unsupported:         ${s.unsupported}  (${pctOf(s.unsupported)})`),
  ];
  if (s.judgeErrors > 0) {
    rows.push(line(colorError(`  Judge errors:        ${s.judgeErrors}`)));
  }
  return rows;
}

function formatCitationDepth(report: EvalReport): string[] {
  var d = report.citationDepth;
  if (d.totalCitations === 0) return [line(), line('Citation Depth:  (no citations)')];
  var pct = (d.claimLevelRate * 100).toFixed(0);
  return [
    line(),
    line(bold("Citation Depth:")),
    line('  Claim-level (with line numbers): ' + d.preciseCitations + ' / ' + d.totalCitations + '  (' + pct + '%)'),
    line('  Avg citations per paragraph: ' + d.avgCitationsPerParagraph.toFixed(1)),
  ];
}

function formatSourceUtilization(report: EvalReport): string[] {
  const u = report.sourceUtilization;
  if (u.totalSources === 0) {
    return [line(), line('Source Utilization:  (no sources yet)')];
  }
  const pct = (u.utilizationRate * 100).toFixed(0);
  const rows = [
    line(),
    line(bold('Source Utilization:  ' + pct + '%')),
    line('  ' + u.citedSources + ' / ' + u.totalSources + ' sources cited by >=1 wiki page'),
  ];
  if (u.uncitedSources > 0) {
    const uncited = u.perSource
      .filter(function(s) { return s.citingPageCount === 0; })
      .map(function(s) { return s.sourceFile; });
    rows.push(line(colorError('  ' + String(u.uncitedSources) + ' uncited:')));
    for (const f of uncited.slice(0, 5)) {
      rows.push(line(dim('    - ' + f)));
    }
    if (uncited.length > 5) {
      rows.push(line(dim('    ... and ' + String(uncited.length - 5) + ' more')));
    }
    rows.push(line(dim('  Tip: re-run llmwiki compile to extract concepts from uncited sources.')));
  }
  return rows;
}

function formatStats(report: EvalReport): string[] {
  const s = report.stats;
  return [
    line(),
    line(bold("Scale:")),
    line(
      `  Sources: ${s.sourceCount}  Pages: ${s.pageCount}  Chunks: ${s.chunkEmbeddingCount}`,
    ),
    line(`  Wiki size: ${s.totalWikiChars.toLocaleString()} chars`),
  ];
}

function formatViolations(violations: string[]): string[] {
  if (violations.length === 0) return [];
  return [line(), ...violations.map((v) => line(colorError(`[FAIL] ${v}`)))];
}

/**
 * Render a human-readable box-drawing table for terminal output.
 * @param report - The completed eval report.
 */
export function formatTerminalReport(report: EvalReport): string {
  const delta = report.delta;
  const rows = [
    top(),
    line(bold("llmwiki eval — Wiki Quality Report")),
    divider(),
    ...formatHealth(report, delta),
    ...formatCoverage(report, delta),
    ...formatSourceUtilization(report),
    ...formatCitationDepth(report),
    ...formatSupport(report, delta),
    ...formatStats(report),
    ...formatViolations(report.thresholdViolations),
    line(),
    bottom(),
  ];
  return rows.join("\n");
}

/**
 * Serialise the eval report as formatted JSON for machine consumption.
 * @param report - The completed eval report.
 */
export function formatJsonReport(report: EvalReport): string {
  return JSON.stringify(report, null, 2);
}

/** Truncate a timestamp ISO string to "YYYY-MM-DD HH:MM" for table display. */
function fmtTimestamp(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

/**
 * Render a trend table of past eval runs for `llmwiki eval history`.
 * Each row shows date, suite, health score, coverage %, and mean citation support.
 * @param reports - Eval reports ordered oldest-first (from loadHistory).
 */
export function formatHistoryTable(reports: EvalReport[]): string {
  if (reports.length === 0) return "No eval history found. Run `llmwiki eval` to record the first run.";

  const header = `${"Date".padEnd(18)}${"Suite".padEnd(7)}${"Health".padEnd(8)}${"Coverage".padEnd(10)}Support`;
  const divider = "─".repeat(header.length);
  const rows = reports.map((r) => {
    const support = r.citationSupport
      ? r.citationSupport.meanScore.toFixed(2)
      : "—";
    return [
      fmtTimestamp(r.timestamp).padEnd(18),
      r.suite.padEnd(7),
      String(r.health.score).padEnd(8),
      `${r.citationCoverage.coveragePercent.toFixed(0)}%`.padEnd(10),
      support,
    ].join("");
  });

  return [`Eval History  (${reports.length} run${reports.length === 1 ? "" : "s"})`, divider, header, divider, ...rows].join("\n");
}

const SCORE_LABELS: Record<number, string> = {
  2: "fully supported",
  1: "partially supported",
  0: "unsupported",
};

function pct(n: number, total: number): string {
  return total === 0 ? "0%" : `${((n / total) * 100).toFixed(0)}%`;
}

/**
 * Render a summary of the citation cache for `llmwiki eval cache show`.
 * @param judgements - All cached judgements.
 * @param summary - Pre-computed score distribution and per-page counts.
 */
export function formatCacheShow(judgements: CitationJudgement[], summary: CacheSummary): string {
  const lines: string[] = [bold(`Citation Cache  ·  ${summary.total} judgements`)];

  if (summary.total === 0) return lines.join("\n");

  lines.push("");
  lines.push(`  Score 2 (fully supported):     ${summary.fullySupported}  (${pct(summary.fullySupported, summary.total)})`);
  lines.push(`  Score 1 (partially supported): ${summary.partiallySupported}  (${pct(summary.partiallySupported, summary.total)})`);
  lines.push(`  Score 0 (unsupported):         ${summary.unsupported}  (${pct(summary.unsupported, summary.total)})`);

  if (summary.byPage.length > 0) {
    lines.push("");
    lines.push("  Top pages:");
    for (const { slug, count } of summary.byPage.slice(0, 10)) {
      lines.push(`    ${slug}:  ${count} judgement${count === 1 ? "" : "s"}`);
    }
  }

  // Suppress unused parameter warning — judgements reserved for future per-file listing
  void judgements;
  return lines.join("\n");
}

const JUDGEMENT_DIVIDER = "─".repeat(55);

/**
 * Render individual citation judgements for `llmwiki eval judgements`.
 * Each entry shows page, file+lines, claim text, source span, score, and reason.
 * @param judgements - Already-filtered list of judgements to display.
 */
export function formatJudgementsDisplay(judgements: CitationJudgement[]): string {
  if (judgements.length === 0) return "No judgements to display.";

  const blocks = judgements.map((j, i) => {
    const scoreLabel = SCORE_LABELS[j.score] ?? "unknown";
    const header = `[${i + 1}/${judgements.length}] Page: ${j.pageSlug}  Score: ${j.score} (${scoreLabel})`;
    return [
      JUDGEMENT_DIVIDER,
      header,
      `  File: ${j.citedFile}  Lines: ${j.lineStart}–${j.lineEnd}`,
      `  Claim: "${j.claimText}"`,
      `  Span:  "${j.spanText}"`,
      `  Reason: ${j.reason}`,
    ].join("\n");
  });

  return [...blocks, JUDGEMENT_DIVIDER].join("\n");
}
