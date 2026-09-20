/**
 * Strict answer publication validation, independent of lock ownership and writes.
 * The caller supplies canonical document bytes and owns the mutation lock; every
 * invocation collects fresh retained/pending state. I/O failures remain errors,
 * never successful empty reports or permission derived from advisory reporting.
 */
import type { AnswerCitationReport } from "./answer-types.js";
import { reportAnswerCitations } from "./answer-report.js";
import { parseFrontmatter } from "../utils/markdown.js";

export type CitationPublicationMode = "direct" | "proposal" | "approval";

/** A completed check whose current observations disallow the requested mode. */
export class CitationPublicationError extends Error {
  /** Preserve exact normalized targets and the fresh report for diagnostics. */
  constructor(
    readonly code: "pending" | "broken",
    readonly targets: string[],
    readonly report: AnswerCitationReport,
  ) {
    super(`Answer publication refused: ${code} citation targets: ${targets.join(", ")}`);
    const pending = report.citations.filter((citation) => citation.status === "pending");
    if (code === "broken" && pending.length) {
      this.message += `; pending citation targets: ${pending.map((citation) => citation.target).join(", ")}`;
    }
    this.name = "CitationPublicationError";
  }
}

/** Apply publication policy to a completed report; broken targets take priority. */
export function assertCitationPublication(report: AnswerCitationReport, mode: CitationPublicationMode): void {
  const broken = report.citations.filter((citation) => citation.status === "broken");
  if (broken.length) throw new CitationPublicationError("broken", broken.map((citation) => citation.target), report);
  const pending = report.citations.filter((citation) => citation.status === "pending");
  if (mode !== "proposal" && pending.length) {
    throw new CitationPublicationError("pending", pending.map((citation) => citation.target), report);
  }
}

/** Validate only the exact parsed body, freshly resolving inside the caller's lock. */
export async function validateCitationPublication(
  root: string, document: string, mode: CitationPublicationMode,
): Promise<AnswerCitationReport> {
  const report = await reportAnswerCitations(root, parseFrontmatter(document).body);
  assertCitationPublication(report, mode);
  return report;
}
