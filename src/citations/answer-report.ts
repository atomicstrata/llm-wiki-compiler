/**
 * Answer-body diagnostics using the production tokenizer and retained resolver.
 * Unique normalized targets retain first-occurrence order; admitted pending
 * proposals are considered only after retained resolution fails. Reports are
 * snapshots, not factual-support judgments or authority to publish an answer.
 */
import type { AnswerCitation, AnswerCitationIndex, AnswerCitationReport } from "./answer-types.js";
import { recognizedWikilinkTargets } from "../wiki/wikilink-tokens.js";
import { resolveBareSlug } from "../viewer/collect.js";
import { collectAnswerCitationIndex } from "./answer-index.js";

/** Build a fresh snapshot and classify the caller's canonical answer body. */
export async function reportAnswerCitations(root: string, body: string): Promise<AnswerCitationReport> {
  return classifyAnswerCitations(body, await collectAnswerCitationIndex(root));
}

/** Classify unique answer wikilinks in first-occurrence order. */
export function classifyAnswerCitations(body: string, index: AnswerCitationIndex): AnswerCitationReport {
  const citations = [...new Set(recognizedWikilinkTargets(body))].map((target): AnswerCitation => {
    const pageId = resolveBareSlug(target, index.retained);
    if (pageId) return { target, status: "resolved", pageId };
    const candidateIds = [...new Set(index.pending
      .filter((entry) => entry.target === target)
      .map((entry) => entry.candidateId))].sort();
    return candidateIds.length
      ? { target, status: "pending", candidateIds }
      : { target, status: "broken" };
  });
  return { version: 1, citations };
}
