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

import { collectAllPages } from "../linter/rules.js";
import { parseFrontmatter, extractClaimCitations } from "../utils/markdown.js";
import type { CitationDepthResult } from "./types.js";

const PROSE_LEAD_RE = /^\p{L}/u;

interface PageCounts { total: number; precise: number; proseParagraphs: number; }

function countPageCitations(body: string): PageCounts {
  const paragraphs = body.split(/\n\s*\n/).filter((p) => PROSE_LEAD_RE.test(p.trim()));
  let total = 0;
  let precise = 0;
  for (const para of paragraphs) {
    const citations = extractClaimCitations(para);
    for (const { spans } of citations) {
      for (const span of spans) {
        total++;
        if (span.lines) precise++;
      }
    }
  }
  return { total, precise, proseParagraphs: paragraphs.length };
}

function buildResult(
  totalCitations: number, citationsWithLineRange: number, totalProseParagraphs: number,
): CitationDepthResult {
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

export async function evaluateCitationDepth(
  root: string,
): Promise<CitationDepthResult> {
  const pages = await collectAllPages(root);
  let totalCitations = 0;
  let citationsWithLineRange = 0;
  let totalProseParagraphs = 0;
  for (const { content } of pages) {
    const { body } = parseFrontmatter(content);
    const counts = countPageCitations(body);
    totalCitations += counts.total;
    citationsWithLineRange += counts.precise;
    totalProseParagraphs += counts.proseParagraphs;
  }
  return buildResult(totalCitations, citationsWithLineRange, totalProseParagraphs);
}
