/**
 * Citation coverage evaluator for the llmwiki eval harness.
 *
 * Measures two things:
 *  - Coverage: what fraction of prose paragraphs contain at least one citation.
 *  - Precision: what fraction of citations point to a source file that exists.
 *
 * Non-prose paragraphs (headings, code blocks, lists, blank lines) are excluded
 * so that only human-readable claim text is counted.
 */

import path from "path";
import { collectAllPages } from "../linter/rules.js";
import { parseFrontmatter, extractClaimCitations, splitProseParagraphs } from "../utils/markdown.js";
import { SOURCES_DIR } from "../utils/constants.js";
import { resolveSourceFile } from "./source-path.js";
import type { CitationCoverageResult, CitationPageResult } from "./types.js";

/** Prose paragraphs start with a Unicode letter. */
interface PageStats {
  pageResult: CitationPageResult;
  proseParagraphs: number;
  citedParagraphs: number;
  totalCitations: number;
  validCitations: number;
}

/** Evaluate citation coverage and precision for a single page body. */
async function evaluatePage(slug: string, body: string, sourcesDir: string): Promise<PageStats> {
  const paragraphs = splitProseParagraphs(body);
  let citedParagraphs = 0;
  let totalCitations = 0;
  let validCitations = 0;

  for (const para of paragraphs) {
    const citations = extractClaimCitations(para);
    if (citations.length === 0) continue;
    citedParagraphs++;
    for (const { spans } of citations) {
      for (const span of spans) {
        totalCitations++;
        if ((await resolveSourceFile(sourcesDir, span.file)) !== null) validCitations++;
      }
    }
  }

  return {
    pageResult: { slug, proseParagraphs: paragraphs.length, citedParagraphs },
    proseParagraphs: paragraphs.length,
    citedParagraphs,
    totalCitations,
    validCitations,
  };
}

/**
 * Measure citation coverage and precision across all wiki pages.
 * @param root - Absolute path to the project root.
 */
export async function evaluateCitationCoverage(
  root: string,
): Promise<CitationCoverageResult> {
  const pages = await collectAllPages(root);
  const sourcesDir = path.join(root, SOURCES_DIR);

  let totalProse = 0;
  let totalCited = 0;
  let totalCitations = 0;
  let totalValid = 0;
  const perPage: CitationPageResult[] = [];

  for (const { filePath, content } of pages) {
    const { body } = parseFrontmatter(content);
    const slug = path.basename(filePath, ".md");
    const stats = await evaluatePage(slug, body, sourcesDir);
    totalProse += stats.proseParagraphs;
    totalCited += stats.citedParagraphs;
    totalCitations += stats.totalCitations;
    totalValid += stats.validCitations;
    perPage.push(stats.pageResult);
  }

  const coveragePercent = totalProse === 0 ? 0 : (totalCited / totalProse) * 100;
  const precisionPercent = totalCitations === 0 ? 0 : (totalValid / totalCitations) * 100;

  return {
    totalProseParagraphs: totalProse,
    citedParagraphs: totalCited,
    coveragePercent,
    totalCitations,
    validCitations: totalValid,
    precisionPercent,
    perPage,
  };
}
