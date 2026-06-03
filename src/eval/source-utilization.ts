/**
 * Source utilization evaluator for the llmwiki eval harness.
 *
 * Measures whether every ingested source has been compiled into the wiki.
 * An uncited source means its concepts were either not extracted or not
 * linked to any generated page — a silent failure mode that no existing
 * lint rule catches.
 *
 * Two metrics:
 *   - utilizationRate: fraction of source files cited by >=1 wiki page.
 *   - uncitedSources: count of sources that exist on disk but appear in
 *     zero citations across the entire wiki.
 */

import { readdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { collectAllPages } from "../linter/rules.js";
import { parseFrontmatter, extractClaimCitations } from "../utils/markdown.js";
import { SOURCES_DIR } from "../utils/constants.js";
import type { SourceUtilizationResult } from "./types.js";

/** Prose paragraphs start with a Unicode letter (same heuristic as citation-coverage.ts). */
const PROSE_LEAD_RE = /^\p{L}/u;

/**
 * Collect the set of source filenames cited by a single wiki page body.
 * Deduplicates so each source is counted once per page regardless of
 * how many citations reference it.
 */
function collectCitedSources(body: string): Set<string> {
  const cited = new Set<string>();
  const paragraphs = body.split(/\n\s*\n/).filter((p) => PROSE_LEAD_RE.test(p.trim()));
  for (const para of paragraphs) {
    const citations = extractClaimCitations(para);
    for (const { spans } of citations) {
      for (const span of spans) {
        cited.add(span.file);
      }
    }
  }
  return cited;
}

/** Count .md files (non-recursive) in a directory; returns 0 if absent. */
async function countMdFiles(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  const entries = await readdir(dir);
  return entries.filter((e) => e.endsWith(".md")).length;
}

/**
 * Evaluate source utilization across the entire wiki.
 * @param root - Absolute path to the project root.
 */
export async function evaluateSourceUtilization(
  root: string,
): Promise<SourceUtilizationResult> {
  const sourcesDir = path.join(root, SOURCES_DIR);
  const [pages, totalSources] = await Promise.all([
    collectAllPages(root),
    countMdFiles(sourcesDir),
  ]);

  if (totalSources === 0) {
    return {
      totalSources: 0,
      citedSources: 0,
      uncitedSources: 0,
      utilizationRate: 1,
      perSource: [],
    };
  }

  const sourceToPages = new Map<string, Set<string>>();

  for (const { filePath, content } of pages) {
    const { body } = parseFrontmatter(content);
    const slug = path.basename(filePath, ".md");
    const citedSources = collectCitedSources(body);

    for (const sourceFile of citedSources) {
      const entry = sourceToPages.get(sourceFile);
      if (entry) {
        entry.add(slug);
      } else {
        sourceToPages.set(sourceFile, new Set([slug]));
      }
    }
  }

  const citedCount = sourceToPages.size;

  // Per-source detail records, sorted by citing page count descending
  const perSource = [...sourceToPages.entries()]
    .map(([sourceFile, pageSlugs]) => ({
      sourceFile,
      citingPageCount: pageSlugs.size,
      citingPages: [...pageSlugs].sort(),
    }))
    .sort((a, b) => b.citingPageCount - a.citingPageCount);

  return {
    totalSources,
    citedSources: citedCount,
    uncitedSources: totalSources - citedCount,
    utilizationRate: Math.round((citedCount / totalSources) * 1000) / 1000,
    perSource,
  };
}
