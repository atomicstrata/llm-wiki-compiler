/**
 * Shared primitives for the wiki lint rule families.
 *
 * The lint rules are split across sibling modules by family — wikilink/orphan/
 * freshness/quality in {@link file://./rules.ts}, citation/provenance in
 * {@link file://./rules-citations.ts}, and schema cross-links in
 * {@link file://./rules-crosslinks.ts}. The helpers every family needs to walk
 * the wiki (`collectAllPages`, `readMarkdownFiles`, `findMatchesInContent`) live
 * here so the family modules can import them WITHOUT importing `rules.ts` — which
 * re-exports the families and would otherwise close an import cycle.
 */

import { readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";

/** Pattern matching ^[filename.md] citation markers in markdown content. */
export const CITATION_PATTERN = /\^\[([^\]]+)\]/g;

/** Match result with its line number and captured group. */
export interface LineMatch {
  captured: string;
  line: number;
}

/**
 * Scan all lines of a page's content and return regex matches with line numbers.
 * Shared by rules that need to locate patterns within page bodies.
 */
export function findMatchesInContent(content: string, pattern: RegExp): LineMatch[] {
  const results: LineMatch[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const matches = lines[i].matchAll(pattern);
    for (const match of matches) {
      results.push({ captured: match[1], line: i + 1 });
    }
  }
  return results;
}

/**
 * Read all .md files from a directory, returning their paths and parsed content.
 * Returns an empty array if the directory does not exist.
 */
async function readMarkdownFiles(
  dirPath: string,
): Promise<Array<{ filePath: string; content: string }>> {
  if (!existsSync(dirPath)) return [];

  const entries = await readdir(dirPath);
  const mdFiles = entries.filter((f) => f.endsWith(".md"));

  const results = await Promise.all(
    mdFiles.map(async (fileName) => {
      const filePath = path.join(dirPath, fileName);
      const content = await readFile(filePath, "utf-8");
      return { filePath, content };
    }),
  );

  return results;
}

/**
 * Collect all wiki pages from both concepts/ and queries/ directories.
 */
export async function collectAllPages(
  root: string,
): Promise<Array<{ filePath: string; content: string }>> {
  const conceptPages = await readMarkdownFiles(path.join(root, CONCEPTS_DIR));
  const queryPages = await readMarkdownFiles(path.join(root, QUERIES_DIR));
  return [...conceptPages, ...queryPages];
}
