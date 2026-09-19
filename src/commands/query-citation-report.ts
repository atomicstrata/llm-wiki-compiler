/**
 * Human-readable diagnostics appended after a query answer finishes streaming.
 * Counts describe recognized link targets, never factual support or save policy;
 * output helpers retain the existing scoped quiet-mode behavior.
 */
import type { AnswerCitationReport } from "../citations/answer-types.js";
import { reportAnswerCitations } from "../citations/answer-report.js";
import type { QueryResult } from "../utils/types.js";
import * as output from "../utils/output.js";

/**
 * Keep query diagnostics optional without weakening the strict collector API.
 * An unavailable snapshot must omit the field, never masquerade as an empty
 * successful report; generation and saving remain outside this recovery boundary.
 */
export async function reportQueryAnswerCitations(root: string, body: string): Promise<Pick<QueryResult, "answerCitations">> {
  try {
    return { answerCitations: await reportAnswerCitations(root, body) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.note(`Answer citations: unavailable (${message})`);
    return {};
  }
}

/** Print exact normalized targets and retained identities from the snapshot. */
export function printAnswerCitationReport(report: AnswerCitationReport): void {
  if (report.citations.length === 0) {
    output.status("i", "Answer citations: none recognized (not a factual-support assessment)");
    return;
  }
  const counts = { resolved: 0, pending: 0, broken: 0 };
  for (const citation of report.citations) counts[citation.status]++;
  output.status("i", `Answer citations: ${counts.resolved} resolved, ${counts.pending} pending, ${counts.broken} broken`);
  for (const citation of report.citations) {
    const identity = citation.status === "resolved" ? ` -> ${citation.pageId}` : "";
    output.status("·", `${citation.status}: ${citation.target}${identity}`);
  }
}
