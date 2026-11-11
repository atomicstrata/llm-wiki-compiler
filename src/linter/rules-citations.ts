/**
 * Citation / provenance lint rules.
 *
 * This family validates the `^[file.md]` citation markers that anchor wiki
 * prose to its sources: broken citations (source file missing or claim-level
 * line span out of bounds) and malformed claim citations (entries that don't
 * parse against the documented `file.md` / `file.md:N-N` / `file.md:N,N-M`
 * / `file.md#LN-LN` grammar). Each on-disk walker has a pure per-page variant
 * so the in-memory candidate-lint path (`compile --review`) surfaces the same
 * findings before a reviewer approves a candidate. Re-exported through
 * {@link file://./rules.ts}.
 *
 * Each walker has ONE BODY, its `...From` form, which holds no project root.
 * `checkBrokenCitationsFrom` owns the page collection, the imported-page
 * exemption, the ONE line-count cache for the whole run and the per-page
 * check; its sources answer only FACTS: the pages, whether a cited source
 * resolves, and a cited source's text. The root-taking walker of the same name
 * is a delegate over local disk sources built for that one call. Nothing is
 * confined here: a cited name is joined under `sources/` exactly as written,
 * as it always was.
 */

import path from "path";
import { diskLocalReads } from "../storage/disk-local-reads.js";
import type { LegacyLocalReads } from "../storage/legacy-local-reads.js";
import {
  isMalformedCitationEntry,
  parseCitationLineRanges,
  parseFrontmatter,
  splitCitationMarker,
} from "../utils/markdown.js";
import { SOURCES_DIR } from "../utils/constants.js";
import type { LintResult } from "./types.js";

/** Rule id for a claim citation that does not parse; the profile registry declares it by this name. */
export const MALFORMED_CLAIM_CITATION_RULE = "malformed-claim-citation";
import {
  CITATION_PATTERN,
  collectAllPagesFrom,
  diskLintPageSources,
  findMatchesInContent,
  type LintPageSources,
  frontmatterOf,
} from "./rules-shared.js";

/** Strip an optional `:start-end` or `#Lstart-Lend` span suffix from a citation entry. */
function stripSpanSuffix(entry: string): string {
  return entry.split(/[:#]/, 1)[0];
}

/** Count the number of lines in a file's text content. */
function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split("\n").length;
}

/**
 * Find ^[filename.md] citations referencing source files that don't exist, and
 * flag claim-level spans whose line ranges exceed the source file's actual length.
 * Handles both single-source ^[file.md] and multi-source ^[a.md, b.md] forms,
 * plus claim-level spans such as `^[file.md:42-58]`, `^[file.md:1, 4-6]`,
 * and `^[file.md#L42-L58]`. Line counts are cached per source file to avoid
 * redundant reads.
 */
export async function checkBrokenCitations(root: string): Promise<LintResult[]> {
  return checkBrokenCitationsFrom(diskCitationLintSources(root));
}

/**
 * {@link checkBrokenCitations} through `sources`: THE ONE BODY. The generic
 * pages, then each page in turn against the cited sources, with one line-count
 * cache shared by every page of the run.
 */
export async function checkBrokenCitationsFrom(sources: CitationLintSources): Promise<LintResult[]> {
  const pages = await collectAllPagesFrom(sources.pages);
  const results: LintResult[] = [];
  const lookup = directoryCitationLookup({ reads: sources.cited, relDir: SOURCES_DIR }, new Map<string, number>());

  for (const page of pages) {
    const { meta } = frontmatterOf(page);
    // Imported pages cite EXTERNAL bundle sources (not copied into sources/), so
    // local source-existence does not apply — exempt them from broken-citation.
    if (meta.provenanceState === "imported") continue;
    const pageFindings = await checkPageCitationsWith(page.content, page.filePath, lookup);
    results.push(...pageFindings);
  }

  return results;
}

/** The two reads a cited source is asked for: whether it resolves, and its whole text. Both follow links; neither is confined. */
export type CitedSourceReads = Pick<LegacyLocalReads, "exists" | "readText">;

/** What the broken-citation walker asks of the project: the pages, then the cited sources, by project-relative path under `sources/`. */
export interface CitationLintSources {
  /** The page collection's sources. */
  pages: LintPageSources;
  /** The cited sources. Asked only for a page that is not imported, and for text only by a span citation. */
  cited: CitedSourceReads;
}

/** LOCAL DISK. The sources for the project at `root`, built per call and private to this module. Building them does no I/O. */
function diskCitationLintSources(root: string): CitationLintSources {
  return { pages: diskLintPageSources(root), cited: diskLocalReads(root) };
}

/**
 * The two things the citation check needs from storage, kept separate on
 * purpose: a bare `^[file.md]` citation only asks whether the source EXISTS,
 * and must not cause its body to be read. Only a citation with a line span
 * asks for a line count. A caller with no filesystem supplies its own lookup.
 */
interface SourceCitationLookup {
  /** Whether the cited source exists. Must not read its content. */
  exists(filename: string): Promise<boolean>;
  /** Line count of a source that exists. Called only for a span citation. */
  lineCount(filename: string): Promise<number>;
}

/** Where cited sources are looked up: a binding, and the sources directory relative to it. */
interface CitedSources {
  reads: CitedSourceReads;
  relDir: string;
}

/**
 * A {@link SourceCitationLookup} over a sources directory read through a
 * binding, caching counts by filename. A source that exists but cannot be read
 * counts zero lines, as it always has.
 */
function directoryCitationLookup({ reads, relDir }: CitedSources, cache: Map<string, number>): SourceCitationLookup {
  return {
    exists: (filename) => reads.exists(path.join(relDir, filename)),
    lineCount: async (filename) => {
      const cached = cache.get(filename);
      if (cached !== undefined) return cached;
      const lineCount = countLines(await reads.readText(path.join(relDir, filename)).catch(() => ""));
      cache.set(filename, lineCount);
      return lineCount;
    },
  };
}

/**
 * Per-page broken-citation check against a `sources/` directory. Reports a
 * citation whose source file is missing or whose line span is out of bounds.
 */
export async function checkPageBrokenCitations(
  content: string,
  filePath: string,
  sourcesDir: string,
  lineCountCache: Map<string, number> = new Map(),
): Promise<LintResult[]> {
  return checkPageCitationsWith(content, filePath, directoryCitationLookup({ reads: diskLocalReads(sourcesDir), relDir: "" }, lineCountCache));
}

/** The same check, with cited sources looked up under the project's `sources/` through `reads`. */
export function checkPageBrokenCitationsFrom(
  reads: LegacyLocalReads,
  content: string,
  filePath: string,
): Promise<LintResult[]> {
  return checkPageCitationsWith(content, filePath, directoryCitationLookup({ reads, relDir: SOURCES_DIR }, new Map()));
}

/**
 * The same check with the source lookup supplied by the caller, so it runs
 * unchanged over any store that can answer the two lookup questions.
 */
async function checkPageCitationsWith(
  content: string,
  filePath: string,
  lookup: SourceCitationLookup,
): Promise<LintResult[]> {
  const results: LintResult[] = [];
  for (const { captured, line } of findMatchesInContent(content, CITATION_PATTERN)) {
    await collectBrokenForMarker(captured, line, filePath, lookup, results);
  }
  return results;
}

/** Inspect every source ref in one captured `^[...]` marker for missing files / OOB spans. */
async function collectBrokenForMarker(
  captured: string,
  line: number,
  pageFile: string,
  lookup: SourceCitationLookup,
  out: LintResult[],
): Promise<void> {
  for (const part of splitCitationMarker(captured)) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const filename = stripSpanSuffix(trimmed);
    if (!(await lookup.exists(filename))) {
      out.push({
        rule: "broken-citation",
        severity: "error",
        file: pageFile,
        message: `Broken citation ^[${filename}] — source file not found`,
        line,
      });
      continue;
    }
    const ranges = parseCitationLineRanges(trimmed);
    if (ranges === null || ranges.length === 0) continue;
    // Only now is the source body read: a bare citation never reaches here.
    const lineCount = await lookup.lineCount(filename);
    if (ranges.every((range) => range.end <= lineCount)) continue;
    out.push({
      rule: "broken-citation",
      severity: "error",
      file: pageFile,
      message: `Claim-level span ^[${trimmed}] is out of bounds (source has only ${lineCount} lines)`,
      line,
    });
  }
}

/**
 * Find ^[...] markers whose entries do not parse against the documented
 * paragraph or claim-level grammar (e.g. `^[file.md:abc]` or `^[file.md#X]`).
 * Detects malformed claim-level citations without breaking the paragraph form.
 */
export async function checkMalformedClaimCitations(root: string): Promise<LintResult[]> {
  return checkMalformedClaimCitationsFrom(diskLintPageSources(root));
}

/** {@link checkMalformedClaimCitations} through `sources`: THE ONE BODY. No page is exempt, imported or not. */
export async function checkMalformedClaimCitationsFrom(sources: LintPageSources): Promise<LintResult[]> {
  const pages = await collectAllPagesFrom(sources);
  const results: LintResult[] = [];
  for (const page of pages) {
    results.push(...checkPageMalformedCitations(page.content, page.filePath));
  }
  return results;
}

/**
 * Pure-body variant of {@link checkMalformedClaimCitations} that inspects
 * a single page's content. Used by both the on-disk lint walker above and
 * the in-memory candidate-lint path so `compile --review` surfaces
 * malformed claim citations before a reviewer approves the candidate.
 */
export function checkPageMalformedCitations(content: string, filePath: string): LintResult[] {
  const results: LintResult[] = [];
  for (const { captured, line } of findMatchesInContent(content, CITATION_PATTERN)) {
    for (const part of splitCitationMarker(captured)) {
      if (!isMalformedCitationEntry(part)) continue;
      results.push({
        rule: MALFORMED_CLAIM_CITATION_RULE,
        severity: "error",
        file: filePath,
        message: `Malformed claim citation ^[${captured}] — expected file.md, file.md:N-N, file.md:N,N-M,…, or file.md#LN-LN`,
        line,
      });
    }
  }
  return results;
}
