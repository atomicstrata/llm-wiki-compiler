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
 * When no valid sources remain after filtering, utilizationRate is null
 * ("not measured").
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

interface InventoryResult {
  /** Names of source files that passed confinement (the valid inventory). */
  validFiles: string[];
  /** Map from valid source filename to its canonical realpath. */
  fileToReal: Map<string, string>;
  /** Non-fatal issues (e.g. out-of-tree symlinks excluded). */
  warnings: string[];
}

/**
 * Build the filtered source inventory by resolving every on-disk source
 * through resolveSourceFile — the same confined resolver used for citation
 * targets. Files that fail resolution are excluded from the inventory and
 * reported as warnings. The caller MUST derive totalSources, perSource,
 * and cited/uncited counts from the returned validFiles, never from the
 * raw readdir() result.
 */
async function resolveSourceInventory(
  sourcesDir: string,
  sourceFiles: string[],
): Promise<InventoryResult> {
  const fileToReal = new Map<string, string>();
  const validFiles: string[] = [];
  const warnings: string[] = [];
  for (const f of sourceFiles) {
    const resolved = await resolveSourceFile(sourcesDir, f);
    if (resolved === null) {
      warnings.push("Unresolvable source file excluded from inventory: " + f);
    } else {
      fileToReal.set(f, resolved);
      validFiles.push(f);
    }
  }
  return { validFiles, fileToReal, warnings };
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
  validFiles: string[],
  fileToReal: Map<string, string>,
  citedRealToPages: Map<string, Set<string>>,
): SourceUtilizationResult["perSource"] {
  const records = validFiles.map((sourceFile) => {
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
  const rawFiles = await listSourceFiles(sourcesDir);

  // Build the filtered inventory — all downstream counts must use this,
  // never rawFiles.length.
  const { validFiles, fileToReal, warnings } = await resolveSourceInventory(sourcesDir, rawFiles);
  const totalSources = validFiles.length;

  if (totalSources === 0) {
    // When raw readdir found files but the confined resolver filtered
    // them all out, carry those warnings forward so the caller can see
    // *why* the inventory is empty.
    const rawWarnings = rawFiles.length > 0 && warnings.length > 0
      ? warnings
      : [];
    return {
      totalSources: 0, citedSources: 0, uncitedSources: 0,
      utilizationRate: null, perSource: [], warnings: rawWarnings,
    };
  }

  const pages = await collectAllPages(root);
  const citedRealToPages = await collectCitedRealpaths(sourcesDir, pages);
  const perSource = buildPerSource(validFiles, fileToReal, citedRealToPages);

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
