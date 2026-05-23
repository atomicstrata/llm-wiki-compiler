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

import { existsSync } from "fs";
import path from "path";
import { collectAllPages } from "../linter/rules.js";
import { parseFrontmatter } from "../utils/markdown.js";
import { SOURCES_DIR } from "../utils/constants.js";
import type { CitationCoverageResult, CitationPageResult } from "./types.js";

/** Matches inline citation markers like ^[source.md] or ^[source.md:1-5]. */
const CITATION_RE = /\^\[([^\]]+)\]/g;

/** Prose paragraphs start with a Unicode letter. */
const PROSE_LEAD_RE = /^\p{L}/u;

/** Strip the line-range suffix from a citation entry to get the bare filename. */
function sourceFilename(entry: string): string {
  return entry.replace(/:[\d-]+$/, "").replace(/#L[\d-]+$/, "").trim();
}

/** Check whether a paragraph contains at least one citation marker. */
function hasCitation(paragraph: string): boolean {
  CITATION_RE.lastIndex = 0;
  return CITATION_RE.test(paragraph);
}

/** Extract all cited source filenames from a paragraph. */
function citedFilenames(paragraph: string): string[] {
  const names: string[] = [];
  CITATION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CITATION_RE.exec(paragraph)) !== null) {
    names.push(sourceFilename(match[1]));
  }
  return names;
}

interface PageStats {
  pageResult: CitationPageResult;
  proseParagraphs: number;
  citedParagraphs: number;
  totalCitations: number;
  validCitations: number;
}

/** Evaluate citation coverage and precision for a single page body. */
function evaluatePage(slug: string, body: string, sourcesDir: string): PageStats {
  const paragraphs = body.split(/\n\s*\n/).filter((p) => PROSE_LEAD_RE.test(p.trim()));
  let citedParagraphs = 0;
  let totalCitations = 0;
  let validCitations = 0;

  for (const para of paragraphs) {
    if (hasCitation(para)) {
      citedParagraphs++;
      const filenames = citedFilenames(para);
      totalCitations += filenames.length;
      for (const file of filenames) {
        if (existsSync(path.join(sourcesDir, file))) validCitations++;
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
    const stats = evaluatePage(slug, body, sourcesDir);
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
