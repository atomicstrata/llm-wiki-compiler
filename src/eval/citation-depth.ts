/**
 * Citation depth evaluator for the llmwiki eval harness.
 *
 * Measures how precise citations are. A bare ^[file.md] says "this paragraph
 * came from somewhere in that source" — useful but vague. A claim-level
 * citation ^[file.md:42-58] pins the exact lines, which is auditable.
 *
 * Metrics:
 *  - claimLevelRate: fraction of citations that include a line range.
 *  - avgCitationsPerParagraph: citation density across prose paragraphs.
 */

import path from "path";
import { collectAllPages } from "../linter/rules.js";
import { parseFrontmatter, extractClaimCitations } from "../utils/markdown.js";
import type { CitationDepthResult } from "./types.js";

const PROSE_LEAD_RE = /^\p{L}/u;

/**
 * Evaluate citation depth across all wiki pages.
 * @param root - Absolute path to the project root.
 */
export async function evaluateCitationDepth(
  root: string,
): Promise<CitationDepthResult> {
  const pages = await collectAllPages(root);

  let totalCitations = 0;
  let citationsWithLineRange = 0;
  let totalProseParagraphs = 0;

  for (const { filePath, content } of pages) {
    const { body } = parseFrontmatter(content);
    const paragraphs = body.split(/\n\s*\n/).filter((p) => PROSE_LEAD_RE.test(p.trim()));
    totalProseParagraphs += paragraphs.length;

    for (const para of paragraphs) {
      const citations = extractClaimCitations(para);
      for (const { spans } of citations) {
        for (const span of spans) {
          totalCitations++;
          if (span.lines) citationsWithLineRange++;
        }
      }
    }
  }

  const claimLevelRate = totalCitations === 0 ? 0 : citationsWithLineRange / totalCitations;
  const avgCitationsPerParagraph = totalProseParagraphs === 0 ? 0
    : Math.round((totalCitations / totalProseParagraphs) * 100) / 100;

  return {
    totalCitations,
    preciseCitations: citationsWithLineRange,
    vagueCitations: totalCitations - citationsWithLineRange,
    claimLevelRate: Math.round(claimLevelRate * 1000) / 1000,
    avgCitationsPerParagraph,
  };
}
