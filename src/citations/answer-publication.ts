/**
 * Strict answer publication validation, independent of lock ownership and writes.
 * The caller supplies canonical document bytes and owns the mutation lock; every
 * invocation collects fresh retained/pending state. I/O failures remain errors,
 * never successful empty reports or permission derived from advisory reporting.
 *
 * Publication replaces `wiki/queries/<slug>.md`, so the answer is judged against
 * the index as it will be after the write: the target entry carries the proposed
 * document's aliases, not the page it replaces. Otherwise a link that resolved
 * only through the old page's aliases would pass and then break on write.
 */
import type { AnswerCitationIndex, AnswerCitationReport, RetainedCitationTarget } from "./answer-types.js";
import { classifyAnswerCitations } from "./answer-report.js";
import { collectAnswerCitationIndex } from "./answer-index.js";
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

/** Replace (or add) the published query page's entry with the proposed document's metadata, keeping scan order. */
function projectPublishedQuery(index: AnswerCitationIndex, slug: string, meta: Record<string, unknown>): AnswerCitationIndex {
  const aliases = Array.isArray(meta.aliases) ? meta.aliases.filter((alias): alias is string => typeof alias === "string") : [];
  const projected: RetainedCitationTarget = { id: `queries/${slug}`, pageDirectory: "queries", slug, aliases };
  const position = index.retained.findIndex((entry) => entry.id === projected.id);
  // Queries scan after concepts, so a new page is appended at the end of the list.
  const retained = position < 0 ? [...index.retained, projected]
    : index.retained.map((entry, i) => (i === position ? projected : entry));
  return { ...index, retained };
}

/**
 * Validate the exact parsed body, freshly resolving inside the caller's lock,
 * against the index as it will be once `document` is written as `wiki/queries/<targetSlug>.md`.
 */
export async function validateCitationPublication(
  root: string, document: string, mode: CitationPublicationMode, targetSlug: string,
): Promise<AnswerCitationReport> {
  const { meta, body } = parseFrontmatter(document);
  const index = projectPublishedQuery(await collectAnswerCitationIndex(root), targetSlug, meta);
  const report = classifyAnswerCitations(body, index);
  assertCitationPublication(report, mode);
  return report;
}
