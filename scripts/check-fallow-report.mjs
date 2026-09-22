/**
 * Apply the pinned GitHub Fallow action's combined-report failure decision.
 * Fallow's own successful exit does not mean its duplication report is empty.
 * Read JSON from stdin so the local command and CI enforce the same findings.
 */
import { readFileSync } from "node:fs";

/** Reject malformed counters rather than accepting an unverifiable report. */
function count(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid Fallow ${name}`);
  return value;
}

try {
  const report = JSON.parse(readFileSync(0, "utf8"));
  const deadCode = count(report.check?.total_issues, "dead-code count");
  const duplication = count(report.dupes?.stats?.clone_groups, "duplication count");
  const complexity = count(report.health?.summary?.functions_above_threshold, "complexity count");
  const coverage = report.health?.runtime_coverage?.findings ?? [];
  if (!Array.isArray(coverage)) throw new Error("Invalid Fallow coverage findings");
  const blockingVerdicts = new Set(["safe_to_delete", "review_required", "low_traffic"]);
  const coverageIssues = coverage.filter(finding => blockingVerdicts.has(finding.verdict)).length;
  const total = deadCode + duplication + complexity + coverageIssues;
  console.log(`Fallow CI: ${deadCode} dead-code, ${duplication} duplication, ${complexity} complexity, ${coverageIssues} coverage findings`);
  if (total > 0) console.error("Run npx fallow for finding locations; these findings also block public CI.");
  process.exitCode = total > 0 ? 1 : 0;
} catch (error) {
  console.error(`Cannot verify Fallow report: ${error.message}`);
  process.exitCode = 2;
}
