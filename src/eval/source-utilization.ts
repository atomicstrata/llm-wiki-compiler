/**
 * Source utilization evaluator for the llmwiki eval harness.
 *
 * Measures whether every ingested source has been compiled into the wiki.
 * An uncited source means its concepts were either not extracted or not
 * linked to any generated page — a silent failure mode that no existing
 * lint rule catches.
 *
 * Algorithm: enumerate on-disk source files, collect raw citation strings
 * from wiki pages, resolve each raw string via resolveSourceFile to a
 * canonical path, then cross-reference. This direction — disk files first,
 * resolveSourceFile as the bridge — ensures ghost citations (files that
 * don't exist) can't inflate the cited count, and normalisation differences
 * between citation strings and real filenames are handled by the existing
 * resolver.
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

/**
 * Collect every raw source-filename string from citation markers in a page
 * body. These are untrusted free-form strings from the LLM — they may
 * reference files that don't exist or use inconsistent casing.
 */
function collectRawCitedFiles(body: string): Set<string> {
  const files = new Set<string>();
  const paragraphs = body.split(/\n\s*\n/).filter((p) => PROSE_LEAD_RE.test(p.trim()));
  for (const para of paragraphs) {
    const citations = extractClaimCitations(para);
    for (const { spans } of citations) {
      for (const span of spans) {
        files.add(span.file);
      }
    }
  }
  return files;
}

/** List .md filenames (non-recursive) in a directory; returns empty array if absent. */
async function listSourceFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  return entries.filter((e) => e.endsWith(".md"));
}

/**
 * Evaluate source utilization across the entire wiki.
 * @param root - Absolute path to the project root.
 */
export async function evaluateSourceUtilization(
  root: string,
): Promise<SourceUtilizationResult> {
  const sourcesDir = path.join(root, SOURCES_DIR);
  const sourceFiles = await listSourceFiles(sourcesDir);
  const totalSources = sourceFiles.length;

  if (totalSources === 0) {
    return {
      totalSources: 0,
      citedSources: 0,
      uncitedSources: 0,
      utilizationRate: 1,
      perSource: [],
    };
  }

  // Build file->realpath map for each on-disk source file
  const fileToReal = new Map<string, string>();
  for (const f of sourceFiles) {
    try {
      fileToReal.set(f, await realpath(path.join(sourcesDir, f)));
    } catch {
      // Vanished — skip
    }
  }

  // Collect raw citations per page, resolve each against sources/
  // resolvedRealPath -> set of page slugs that cite it
  const pages = await collectAllPages(root);
  const citedRealToPages = new Map<string, Set<string>>();

  for (const { filePath, content } of pages) {
    const { body } = parseFrontmatter(content);
    const slug = path.basename(filePath, ".md");

    for (const rawFile of collectRawCitedFiles(body)) {
      const resolved = await resolveSourceFile(sourcesDir, rawFile);
      if (resolved === null) continue; // ghost citation — skip
      const entry = citedRealToPages.get(resolved);
      if (entry) {
        entry.add(slug);
      } else {
        citedRealToPages.set(resolved, new Set([slug]));
      }
    }
  }

  // Build per-source records: for every on-disk file, look up whether
  // its realpath was cited
  const perSource = sourceFiles.map((sourceFile) => {
    const real = fileToReal.get(sourceFile);
    const pageSlugs = real ? citedRealToPages.get(real) : undefined;
    return {
      sourceFile,
      citingPageCount: pageSlugs ? pageSlugs.size : 0,
      citingPages: pageSlugs ? [...pageSlugs].sort() : ([] as string[]),
    };
  });

  perSource.sort((a, b) => {
    if (a.citingPageCount !== b.citingPageCount) return b.citingPageCount - a.citingPageCount;
    return a.sourceFile.localeCompare(b.sourceFile);
  });

  const citedCount = perSource.filter((e) => e.citingPageCount > 0).length;

  return {
    totalSources,
    citedSources: citedCount,
    uncitedSources: totalSources - citedCount,
    utilizationRate: Math.round((citedCount / totalSources) * 1000) / 1000,
    perSource,
  };
}
