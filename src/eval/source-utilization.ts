/**
 * Source utilization evaluator for the llmwiki eval harness.
 *
 * Measures whether every ingested source has been compiled into the wiki.
 * An uncited source means its concepts were either not extracted or not
 * linked to any generated page — a silent failure mode that no existing
 * lint rule catches.
 *
 * Algorithm: enumerate on-disk source files, resolve each through
 * resolveSourceFile to a canonical realpath, then cross-reference with
 * citation targets resolved the same way. Both sides use the same confined
 * resolver so symlinks and path differences are handled consistently.
 * When totalSources is 0, utilizationRate is null ("not measured").
 */

import { readdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { collectAllPages } from "../linter/rules.js";
import { parseFrontmatter, extractClaimCitations, splitProseParagraphs } from "../utils/markdown.js";
import { resolveSourceFile } from "./source-path.js";
import { SOURCES_DIR } from "../utils/constants.js";
import type { SourceUtilizationResult } from "./types.js";

function collectRawCitedFiles(body: string): Set<string> {
  const files = new Set<string>();
  for (const para of splitProseParagraphs(body)) {
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

function pageSlug(filePath: string): string {
  const dir = path.basename(path.dirname(filePath));
  return dir + "/" + path.basename(filePath, ".md");
}

/**
 * Resolve each on-disk source file through the same confined resolver
 * used for citation targets. Files that fail resolution (e.g. symlinks
 * pointing outside sources/) are excluded from the inventory and reported
 * as warnings so they don't skew the cited/uncited counts.
 */
async function buildFileToRealMap(
  sourcesDir: string,
  sourceFiles: string[],
  warnings: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const f of sourceFiles) {
    const resolved = await resolveSourceFile(sourcesDir, f);
    if (resolved === null) {
      warnings.push("Unresolvable source file excluded from inventory: " + f);
    } else {
      map.set(f, resolved);
    }
  }
  return map;
}

async function collectCitedRealpaths(
  sourcesDir: string,
  pages: Array<{ filePath: string; content: string }>,
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
  const warnings: string[] = [];

  if (totalSources === 0) {
    return { totalSources: 0, citedSources: 0, uncitedSources: 0, utilizationRate: null, perSource: [], warnings };
  }

  const fileToReal = await buildFileToRealMap(sourcesDir, sourceFiles, warnings);
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
    warnings,
  };
}
