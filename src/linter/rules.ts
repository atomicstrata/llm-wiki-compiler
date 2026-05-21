/**
 * Lint rules for wiki quality checks.
 *
 * Each rule is a function that takes a project root path and returns
 * an array of LintResult diagnostics. Rules perform pure static analysis
 * with no LLM calls — they inspect frontmatter, wikilinks, citations,
 * and file structure to find potential issues.
 */

import { readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import {
  isMalformedCitationEntry,
  parseFrontmatter,
  parseProvenanceMetadata,
  safeReadFile,
  slugify,
} from "../utils/markdown.js";
import {
  CONCEPTS_DIR,
  LOW_CONFIDENCE_THRESHOLD,
  MAX_INFERRED_PARAGRAPHS_WITHOUT_CITATIONS,
  QUERIES_DIR,
  SOURCES_DIR,
} from "../utils/constants.js";
import type { LintResult } from "./types.js";
import {
  countWikilinks,
  resolvePageKind,
  type SchemaConfig,
} from "../schema/index.js";

/** Minimum body length (in characters) for a page to be considered non-empty. */
const MIN_BODY_LENGTH = 50;

/** Pattern matching [[Wikilink Title]] references in markdown content. */
const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g;

/** Pattern matching ^[filename.md] citation markers in markdown content. */
const CITATION_PATTERN = /\^\[([^\]]+)\]/g;

/** Match result with its line number and captured group. */
interface LineMatch {
  captured: string;
  line: number;
}

/**
 * Scan all lines of a page's content and return regex matches with line numbers.
 * Shared by rules that need to locate patterns within page bodies.
 */
function findMatchesInContent(content: string, pattern: RegExp): LineMatch[] {
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
async function collectAllPages(
  root: string,
): Promise<Array<{ filePath: string; content: string }>> {
  const conceptPages = await readMarkdownFiles(path.join(root, CONCEPTS_DIR));
  const queryPages = await readMarkdownFiles(path.join(root, QUERIES_DIR));
  return [...conceptPages, ...queryPages];
}

/**
 * Build a set of slugs for all existing wiki pages.
 * Used to verify that wikilink targets actually exist.
 */
function buildPageSlugSet(
  pages: Array<{ filePath: string }>,
): Set<string> {
  const slugs = new Set<string>();
  for (const page of pages) {
    const baseName = path.basename(page.filePath, ".md");
    slugs.add(baseName.toLowerCase());
  }
  return slugs;
}

/** Find [[Title]] wikilinks that don't match any existing wiki page. */
export async function checkBrokenWikilinks(root: string): Promise<LintResult[]> {
  const pages = await collectAllPages(root);
  const existingSlugs = buildPageSlugSet(pages);
  const results: LintResult[] = [];

  for (const page of pages) {
    for (const { captured, line } of findMatchesInContent(page.content, WIKILINK_PATTERN)) {
      const linkTarget = captured.split("|")[0].trim();
      const linkSlug = slugify(linkTarget);
      if (!existingSlugs.has(linkSlug)) {
        results.push({
          rule: "broken-wikilink",
          severity: "error",
          file: page.filePath,
          message: `Broken wikilink [[${captured}]] — no matching page found`,
          line,
        });
      }
    }
  }

  return results;
}

/** Find pages with `orphaned: true` in their frontmatter. */
export async function checkOrphanedPages(root: string): Promise<LintResult[]> {
  const pages = await collectAllPages(root);
  const results: LintResult[] = [];

  for (const page of pages) {
    const { meta } = parseFrontmatter(page.content);
    if (meta.orphaned === true) {
      results.push({
        rule: "orphaned-page",
        severity: "warning",
        file: page.filePath,
        message: `Page is marked as orphaned`,
      });
    }
  }

  return results;
}

/** Find pages with empty or missing `summary` in frontmatter. */
export async function checkMissingSummaries(root: string): Promise<LintResult[]> {
  const pages = await collectAllPages(root);
  const results: LintResult[] = [];

  for (const page of pages) {
    const { meta } = parseFrontmatter(page.content);
    const summary = meta.summary;
    const isMissing = !summary || (typeof summary === "string" && summary.trim() === "");

    if (isMissing) {
      results.push({
        rule: "missing-summary",
        severity: "warning",
        file: page.filePath,
        message: `Page has no summary in frontmatter`,
      });
    }
  }

  return results;
}

/** Find multiple pages whose titles match case-insensitively. */
export async function checkDuplicateConcepts(root: string): Promise<LintResult[]> {
  const pages = await collectAllPages(root);
  const titleMap = new Map<string, string[]>();

  for (const page of pages) {
    const { meta } = parseFrontmatter(page.content);
    const title = typeof meta.title === "string" ? meta.title : "";
    if (!title) continue;

    const normalizedTitle = title.toLowerCase().trim();
    const existing = titleMap.get(normalizedTitle) ?? [];
    existing.push(page.filePath);
    titleMap.set(normalizedTitle, existing);
  }

  const results: LintResult[] = [];
  for (const [title, files] of titleMap) {
    if (files.length <= 1) continue;
    for (const file of files) {
      results.push({
        rule: "duplicate-concept",
        severity: "error",
        file,
        message: `Duplicate title "${title}" — also in ${files.filter((f) => f !== file).join(", ")}`,
      });
    }
  }

  return results;
}

/** Find pages with frontmatter but very short or empty body content. */
export async function checkEmptyPages(root: string): Promise<LintResult[]> {
  const pages = await collectAllPages(root);
  const results: LintResult[] = [];

  for (const page of pages) {
    const { meta, body } = parseFrontmatter(page.content);
    const hasTitle = typeof meta.title === "string" && meta.title.trim() !== "";
    const isBodyEmpty = body.trim().length < MIN_BODY_LENGTH;

    if (hasTitle && isBodyEmpty) {
      results.push({
        rule: "empty-page",
        severity: "warning",
        file: page.filePath,
        message: `Page body is empty or too short (< ${MIN_BODY_LENGTH} chars)`,
      });
    }
  }

  return results;
}

/** Strip an optional `:start-end` or `#Lstart-Lend` span suffix from a citation entry. */
function stripSpanSuffix(entry: string): string {
  const colonIdx = entry.indexOf(":");
  const hashIdx = entry.indexOf("#");
  const cuts = [colonIdx, hashIdx].filter((i) => i >= 0);
  if (cuts.length === 0) return entry;
  return entry.slice(0, Math.min(...cuts));
}

/**
 * Flag pages whose frontmatter declares confidence below the threshold.
 * Pages without a confidence field are silently skipped to preserve
 * backward-compatibility with pre-existing wikis.
 */
export async function checkLowConfidencePages(root: string): Promise<LintResult[]> {
  const pages = await collectAllPages(root);
  const results: LintResult[] = [];

  for (const page of pages) {
    const { meta } = parseFrontmatter(page.content);
    const { confidence } = parseProvenanceMetadata(meta);
    if (confidence === undefined || confidence >= LOW_CONFIDENCE_THRESHOLD) continue;
    results.push({
      rule: "low-confidence",
      severity: "warning",
      file: page.filePath,
      message: `Page confidence ${confidence.toFixed(2)} is below ${LOW_CONFIDENCE_THRESHOLD}`,
    });
  }

  return results;
}

/** Flag pages whose frontmatter records contradictions with other pages. */
export async function checkContradictedPages(root: string): Promise<LintResult[]> {
  const pages = await collectAllPages(root);
  const results: LintResult[] = [];

  for (const page of pages) {
    const { meta } = parseFrontmatter(page.content);
    const { contradictedBy } = parseProvenanceMetadata(meta);
    if (!contradictedBy || contradictedBy.length === 0) continue;
    const slugs = contradictedBy.map((r) => r.slug).join(", ");
    results.push({
      rule: "contradicted-page",
      severity: "warning",
      file: page.filePath,
      message: `Page contradicts: ${slugs}`,
    });
  }

  return results;
}

/**
 * Flag pages with too many inferred paragraphs unsupported by direct
 * citations. Always derived from the rendered page body — the body is
 * the single source of truth, no metadata field is consulted. Earlier
 * versions trusted an LLM-estimated `inferredParagraphs` frontmatter
 * field, but that estimate was made before the page even existed and
 * routinely disagreed with what the model actually produced. Counting
 * uncited prose paragraphs in the rendered body matches what a
 * reviewer would see and survives hand-edits.
 */
export async function checkInferredWithoutCitations(root: string): Promise<LintResult[]> {
  const pages = await collectAllPages(root);
  const results: LintResult[] = [];

  for (const page of pages) {
    const { body } = parseFrontmatter(page.content);
    const inferred = countUncitedProseParagraphs(body);
    if (inferred <= MAX_INFERRED_PARAGRAPHS_WITHOUT_CITATIONS) continue;
    results.push({
      rule: "excess-inferred-paragraphs",
      severity: "warning",
      file: page.filePath,
      message: `Page has ${inferred} inferred paragraphs without citations (max ${MAX_INFERRED_PARAGRAPHS_WITHOUT_CITATIONS})`,
    });
  }

  return results;
}

/**
 * Match a paragraph that looks like prose (not a heading, list, or code
 * block). Uses the Unicode `Letter` property so non-ASCII pages
 * generated via `--lang Chinese`, `--lang Japanese`, etc. (#46) are
 * still detected — the previous `[A-Za-z]` form silently dropped CJK,
 * Cyrillic, Greek, and Arabic prose, leaving
 * `excess-inferred-paragraphs` blind on those pages.
 */
const PROSE_PARAGRAPH_LEAD = /^\p{L}/u;

/** Count prose paragraphs in a body that lack a ^[citation] marker. */
function countUncitedProseParagraphs(body: string): number {
  const paragraphs = body.split(/\n\s*\n/);
  let count = 0;
  for (const block of paragraphs) {
    const trimmed = block.trim();
    if (trimmed.length === 0) continue;
    if (!PROSE_PARAGRAPH_LEAD.test(trimmed)) continue;
    if (CITATION_PATTERN.test(trimmed)) {
      CITATION_PATTERN.lastIndex = 0;
      continue;
    }
    CITATION_PATTERN.lastIndex = 0;
    count += 1;
  }
  return count;
}

/** Regex matching the `:start-end` span suffix on a citation entry. */
const COLON_SPAN_PATTERN = /^[^:#]+:(\d+)(?:-(\d+))?$/;

/** Regex matching the `#Lstart-Lend` span suffix on a citation entry. */
const HASH_SPAN_PATTERN = /^[^:#]+#L(\d+)(?:-L(\d+))?$/;

/** Parsed line range from a citation entry, or null if no range is present. */
interface ParsedLineRange {
  start: number;
  end: number;
}

/**
 * Enforce per-kind cross-link minimums declared in the schema.
 * For each page, resolve its kind, look up the rule, and warn when the page
 * body has fewer wikilinks than the rule requires. Pages with kind `concept`
 * and a minimum of 0 (the default) generate no diagnostics, so existing
 * projects without a schema file see no behaviour change.
 *
 * Implementation delegates to {@link checkPageCrossLinks} per page so the
 * actual rule logic lives in exactly one place — the on-disk walker just
 * fans the per-page helper across `collectAllPages`.
 * @param root - Project root directory.
 * @param schema - Resolved schema config.
 */
export async function checkSchemaCrossLinks(
  root: string,
  schema: SchemaConfig,
): Promise<LintResult[]> {
  const pages = await collectAllPages(root);
  const results: LintResult[] = [];
  for (const page of pages) {
    results.push(...checkPageCrossLinks(page.content, page.filePath, schema));
  }
  return results;
}

/**
 * Check cross-link minimums for a single page given as a raw content string.
 *
 * Unlike `checkSchemaCrossLinks`, this function operates on content already in
 * memory without reading from disk. Used by the review pipeline to attach
 * schema violations to a candidate at write time so `review show` can surface
 * them before the reviewer approves the page.
 *
 * The `filePath` parameter is embedded verbatim in each `LintResult.file` so
 * callers control how the candidate is identified in diagnostic output.
 *
 * @param content - Full page content including frontmatter.
 * @param filePath - Logical file path to embed in diagnostics (may be virtual).
 * @param schema - Resolved schema config.
 * @returns Lint results for this single page, empty when no violations found.
 */
export function checkPageCrossLinks(
  content: string,
  filePath: string,
  schema: SchemaConfig,
): LintResult[] {
  const { meta, body } = parseFrontmatter(content);
  const kind = resolvePageKind(meta.kind, schema);
  const rule = schema.kinds[kind];
  if (rule.minWikilinks <= 0) return [];

  const linkCount = countWikilinks(body);
  if (linkCount >= rule.minWikilinks) return [];

  return [
    {
      rule: "schema-cross-link-minimum",
      severity: "warning",
      file: filePath,
      message:
        `Page kind "${kind}" requires at least ${rule.minWikilinks} ` +
        `[[wikilinks]] but only ${linkCount} found.`,
    },
  ];
}

/** Extract the line range from a citation entry string, or return null if there is none. */
function parseLineRange(entry: string): ParsedLineRange | null {
  const colonMatch = COLON_SPAN_PATTERN.exec(entry);
  if (colonMatch) {
    const start = Number(colonMatch[1]);
    const end = colonMatch[2] !== undefined ? Number(colonMatch[2]) : start;
    return { start, end };
  }
  const hashMatch = HASH_SPAN_PATTERN.exec(entry);
  if (hashMatch) {
    const start = Number(hashMatch[1]);
    const end = hashMatch[2] !== undefined ? Number(hashMatch[2]) : start;
    return { start, end };
  }
  return null;
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
 * plus the claim-level extension `^[file.md:42-58]` / `^[file.md#L42-L58]`.
 * Line counts are cached per source file to avoid redundant reads.
 */
export async function checkBrokenCitations(root: string): Promise<LintResult[]> {
  const pages = await collectAllPages(root);
  const sourcesDir = path.join(root, SOURCES_DIR);
  const results: LintResult[] = [];
  const lineCountCache = new Map<string, number>();

  for (const page of pages) {
    const pageFindings = await checkPageBrokenCitations(
      page.content,
      page.filePath,
      sourcesDir,
      lineCountCache,
    );
    results.push(...pageFindings);
  }

  return results;
}

/**
 * Pure-body variant of {@link checkBrokenCitations} that inspects a single
 * page's content against an in-memory or on-disk sources directory. Used
 * by the on-disk lint walker above, and by the in-memory candidate-lint
 * path so `compile --review` surfaces broken-source-file and out-of-bounds
 * span findings before a reviewer approves the candidate.
 *
 * @param content - Full page markdown including frontmatter.
 * @param filePath - Logical path embedded in diagnostics (may be virtual).
 * @param sourcesDir - Absolute path to the project's sources/ directory.
 * @param lineCountCache - Optional cross-page cache; provide one when
 *   linting many pages so source file line counts aren't re-read.
 */
export async function checkPageBrokenCitations(
  content: string,
  filePath: string,
  sourcesDir: string,
  lineCountCache: Map<string, number> = new Map(),
): Promise<LintResult[]> {
  const results: LintResult[] = [];
  for (const { captured, line } of findMatchesInContent(content, CITATION_PATTERN)) {
    await collectBrokenForMarker(captured, line, filePath, sourcesDir, lineCountCache, results);
  }
  return results;
}

/** Append broken-citation diagnostics for every entry inside a single ^[...] marker. */
async function collectBrokenForMarker(
  captured: string,
  line: number,
  pageFile: string,
  sourcesDir: string,
  lineCountCache: Map<string, number>,
  out: LintResult[],
): Promise<void> {
  for (const part of captured.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const filename = stripSpanSuffix(trimmed);
    const citedPath = path.join(sourcesDir, filename);
    if (!existsSync(citedPath)) {
      out.push({
        rule: "broken-citation",
        severity: "error",
        file: pageFile,
        message: `Broken citation ^[${filename}] — source file not found`,
        line,
      });
      continue;
    }
    const range = parseLineRange(trimmed);
    if (range === null) continue;
    const lineCount = await resolveLineCount(citedPath, filename, lineCountCache);
    if (range.end <= lineCount) continue;
    out.push({
      rule: "broken-citation",
      severity: "error",
      file: pageFile,
      message: `Claim-level span ^[${trimmed}] is out of bounds (source has only ${lineCount} lines)`,
      line,
    });
  }
}

/** Return the line count for a source file, reading and caching if necessary. */
async function resolveLineCount(
  citedPath: string,
  filename: string,
  cache: Map<string, number>,
): Promise<number> {
  const cached = cache.get(filename);
  if (cached !== undefined) return cached;
  const content = await safeReadFile(citedPath);
  const lineCount = countLines(content);
  cache.set(filename, lineCount);
  return lineCount;
}

/**
 * Find ^[...] markers whose entries do not parse against the documented
 * paragraph or claim-level grammar (e.g. `^[file.md:abc]` or `^[file.md#X]`).
 * Detects malformed claim-level citations without breaking the paragraph form.
 */
export async function checkMalformedClaimCitations(root: string): Promise<LintResult[]> {
  const pages = await collectAllPages(root);
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
    for (const part of captured.split(",")) {
      if (!isMalformedCitationEntry(part)) continue;
      results.push({
        rule: "malformed-claim-citation",
        severity: "error",
        file: filePath,
        message: `Malformed claim citation ^[${captured}] — expected file.md, file.md:N-N, or file.md#LN-LN`,
        line,
      });
    }
  }
  return results;
}
