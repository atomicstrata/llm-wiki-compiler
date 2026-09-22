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
 * The page set a rule family walks. TWO SCOPES, and which one a rule takes is a
 * jurisdiction decision, not a convenience:
 *
 * - `"generic"` — the generic compiler's `concepts/` and `queries/` pages. The
 *   quality family (summaries, body length, staleness, orphans) stays here,
 *   because on a profile project those judgements belong to the PROFILE lint
 *   family, which knows each entity kind's required fields — the generic rules
 *   firing there too would double-report every finding.
 * - `"wiki-wide"` — every markdown page under `wiki/`, whatever directories the
 *   active profile declares. The explicit tiered CLI and §4.6 fix plan take
 *   this scope for wikilinks. Existing flat lint and direct rule calls retain
 *   generic coverage, including on old profile projects.
 *
 * A fix plan and the broken-wikilink check it accompanies take the SAME scope: their
 * agreement ("no fix where the linter saw no problem") is a tested invariant,
 * and two scopes would break it silently on exactly the pages one saw and the
 * other did not.
 */
export type PageScope = "generic" | "wiki-wide";

/** Collect the pages one rule family walks, under its declared scope. */
export async function collectAllPages(
  root: string, scope: PageScope = "generic",
): Promise<Array<{ filePath: string; content: string }>> {
  if (scope === "generic") {
    const conceptPages = await readMarkdownFiles(path.join(root, CONCEPTS_DIR));
    const queryPages = await readMarkdownFiles(path.join(root, QUERIES_DIR));
    return [...conceptPages, ...queryPages];
  }
  const wikiRoot = path.join(root, "wiki");
  if (!existsSync(wikiRoot)) return [];
  // RECURSIVE, because a profile may validly declare nested entity directories
  // (wiki/research/papers) — a one-level walk silently returned no pages for
  // them, which is the exact partial-coverage failure this widening replaced.
  // Bounded by depth so a symlink cycle cannot walk forever; dot-directories
  // (.obsidian) are artifacts, not pages.
  const pages = await walkMarkdown(wikiRoot, MAX_WIKI_WALK_DEPTH);
  return pages.sort((left, right) => left.filePath.localeCompare(right.filePath));
}

/** The deepest nesting a profile's entity directories may reasonably reach. */
const MAX_WIKI_WALK_DEPTH = 6;

/** Every markdown page under `dir`, to the given remaining depth. */
async function walkMarkdown(
  dir: string, depth: number,
): Promise<Array<{ filePath: string; content: string }>> {
  if (depth === 0) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const results = await Promise.all(entries
    .filter((entry) => !entry.name.startsWith("."))
    .map(async (entry) => {
      if (entry.isDirectory()) return walkMarkdown(path.join(dir, entry.name), depth - 1);
      if (!entry.isFile() || !entry.name.endsWith(".md")) return [];
      const filePath = path.join(dir, entry.name);
      return [{ filePath, content: await readFile(filePath, "utf-8") }];
    }));
  return results.flat();
}
