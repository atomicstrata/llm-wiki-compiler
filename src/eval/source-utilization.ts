/**
 * Source utilization evaluator for the llmwiki eval harness.
 *
 * Measures whether every ingested source has been compiled into the wiki.
 * An uncited source means its concepts were either not extracted or not
 * linked to any generated page — a silent failure mode that no existing
 * lint rule catches.
 *
 * Algorithm: enumerate on-disk source files, resolve each citation string
 * via the existing resolveSourceFile to a canonical realpath, then
 * cross-reference in canonical-path space. Because cited counts are derived
 * from the on-disk file set (not from raw citation strings), citations that
 * point to non-existent files are simply skipped and never affect the
 * utilization numbers.
 */

import { readdir, realpath } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { collectAllPages } from "../linter/rules.js";
import { parseFrontmatter, extractClaimCitations } from "../utils/markdown.js";
import { resolveSourceFile } from "./source-path.js";
import { SOURCES_DIR } from "../utils/constants.js";
import type { SourceUtilizationResult } from "./types.js";

const PROSE_LEAD_RE = /^\p{L}/u;

function collectRawCitedFiles(body: string): Set<string> {
  const files = new Set<string>();
  const paragraphs = body.split(/\n\s*\n/).filter((p) => PROSE_LEAD_RE.test(p.trim()));
  for (const para of paragraphs) {
    const citations = extractClaimCitations(para);
    for (const { spans } of citations) {
      for (const span of spans) files.add(span.file);
    }
  }
  return files;
}

async function listSourceFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  return entries.filter((e) => e.endsWith(".md"));
}

async function buildFileToRealMap(
  sourcesDir: string, sourceFiles: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const f of sourceFiles) {
    try { map.set(f, await realpath(path.join(sourcesDir, f))); } catch { /* skip */ }
  }
  return map;
}

function pageSlug(filePath: string): string {
  const dir = filePath.includes("queries") ? "queries" : "concepts";
  return dir + "/" + path.basename(filePath, ".md");
}

async function collectCitedRealpaths(
  sourcesDir: string, pages: Array<{ filePath: string; content: string }>,
): Promise<Map<string, Set<string>>> {
  const citedRealToPages = new Map<string, Set<string>>();
  for (const { filePath, content } of pages) {
    const { body } = parseFrontmatter(content);
    const slug = pageSlug(filePath);
    for (const rawFile of collectRawCitedFiles(body)) {
      const resolved = await resolveSourceFile(sourcesDir, rawFile);
      if (resolved === null) continue;
      const entry = citedRealToPages.get(resolved);
      if (entry) entry.add(slug);
      else citedRealToPages.set(resolved, new Set([slug]));
    }
  }
  return citedRealToPages;
}

function buildPerSource(
  sourceFiles: string[],
  fileToReal: Map<string, string>,
  citedRealToPages: Map<string, Set<string>>,
): SourceUtilizationResult["perSource"] {
  const records = sourceFiles.map((sourceFile) => {
    const real = fileToReal.get(sourceFile);
    const pageSlugs = real ? citedRealToPages.get(real) : undefined;
    return {
      sourceFile,
      citingPageCount: pageSlugs ? pageSlugs.size : 0,
      citingPages: pageSlugs ? [...pageSlugs].sort() : ([] as string[]),
    };
  });
  records.sort((a, b) => {
    if (a.citingPageCount !== b.citingPageCount) return b.citingPageCount - a.citingPageCount;
    return a.sourceFile.localeCompare(b.sourceFile);
  });
  return records;
}

export async function evaluateSourceUtilization(
  root: string,
): Promise<SourceUtilizationResult> {
  const sourcesDir = path.join(root, SOURCES_DIR);
  const sourceFiles = await listSourceFiles(sourcesDir);
  const totalSources = sourceFiles.length;
  if (totalSources === 0) {
    return { totalSources: 0, citedSources: 0, uncitedSources: 0, utilizationRate: 1, perSource: [] };
  }
  const fileToReal = await buildFileToRealMap(sourcesDir, sourceFiles);
  const pages = await collectAllPages(root);
  const citedRealToPages = await collectCitedRealpaths(sourcesDir, pages);
  const perSource = buildPerSource(sourceFiles, fileToReal, citedRealToPages);
  const citedCount = perSource.filter((e) => e.citingPageCount > 0).length;
  return {
    totalSources,
    citedSources: citedCount,
    uncitedSources: totalSources - citedCount,
    utilizationRate: Math.round((citedCount / totalSources) * 1000) / 1000,
    perSource,
  };
}
