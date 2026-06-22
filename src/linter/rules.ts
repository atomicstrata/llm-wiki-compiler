/**
 * Lint rules for wiki quality checks.
 *
 * Each rule is a function that takes a project root path and returns
 * an array of LintResult diagnostics. Rules perform pure static analysis
 * with no LLM calls — they inspect frontmatter, wikilinks, citations,
 * and file structure to find potential issues.
 *
 * This module hosts the wikilink/orphan/freshness/quality family directly and
 * RE-EXPORTS the citation/provenance family ({@link file://./rules-citations.ts})
 * and the schema cross-link family ({@link file://./rules-crosslinks.ts}) so
 * `src/linter/index.ts` and every other importer see a single `rules.js`
 * surface unchanged. Shared walk helpers live in
 * {@link file://./rules-shared.ts} to keep the families cycle-free.
 */

import path from "path";
import {
  parseFrontmatter,
  parseProvenanceMetadata,
  slugify,
} from "../utils/markdown.js";
import {
  LOW_CONFIDENCE_THRESHOLD,
  MAX_INFERRED_PARAGRAPHS_WITHOUT_CITATIONS,
} from "../utils/constants.js";
import type { LintResult } from "./types.js";
import { computeFreshness } from "../freshness/index.js";
import type { FreshnessSnapshot } from "../freshness/types.js";
import { listLinkResolvablePendingSlugs } from "../compiler/candidates.js";
import {
  CITATION_PATTERN,
  collectAllPages,
  findMatchesInContent,
} from "./rules-shared.js";

// Re-export the shared walk helpers and the citation + cross-link families so
// every importer of `rules.js` keeps a single, unchanged surface.
export { collectAllPages } from "./rules-shared.js";
export {
  checkBrokenCitations,
  checkPageBrokenCitations,
  checkMalformedClaimCitations,
  checkPageMalformedCitations,
} from "./rules-citations.js";
export {
  checkSchemaCrossLinks,
  checkPageCrossLinks,
} from "./rules-crosslinks.js";

/** Minimum body length (in characters) for a page to be considered non-empty. */
const MIN_BODY_LENGTH = 50;

/** Pattern matching [[Wikilink Title]] references in markdown content. */
const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g;

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
  const pendingSlugs = await listLinkResolvablePendingSlugs(root);
  const results: LintResult[] = [];

  for (const page of pages) {
    for (const { captured, line } of findMatchesInContent(page.content, WIKILINK_PATTERN)) {
      const linkTarget = captured.split("|")[0].trim();
      const linkSlug = slugify(linkTarget);
      if (!existingSlugs.has(linkSlug) && pendingSlugs.has(linkSlug)) {
        results.push({
          rule: "pending-target",
          severity: "info",
          file: page.filePath,
          message: `Wikilink [[${captured}]] points to a page awaiting review`,
          line,
        });
      } else if (!existingSlugs.has(linkSlug)) {
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

/**
 * Report pages whose computed freshness is actionable: `stale` (a source
 * changed since compile) or `orphaned` (every source it derived from was
 * deleted but no compile has cleaned the page up yet). Pages already flagged
 * `orphaned: true` in frontmatter are left to {@link checkOrphanedPages} so the
 * two rules never double-report. `fresh` and `unverified` are not findings —
 * unverified covers legitimately unowned pages (query pages, hand-authored
 * content) that should not warn. Receives the shared freshness snapshot so the
 * source-hash pass happens once per lint run.
 */
export async function checkStalePages(root: string, snapshot: FreshnessSnapshot): Promise<LintResult[]> {
  const pages = await collectAllPages(root);
  const results: LintResult[] = [];
  for (const page of pages) {
    const { meta } = parseFrontmatter(page.content);
    if (meta.orphaned === true) continue;
    const slug = path.basename(page.filePath, ".md");
    const pageDirectory = path.basename(path.dirname(page.filePath)) === "queries" ? "queries" : "concepts";
    const { freshnessStatus } = computeFreshness({ slug, pageDirectory, frontmatter: meta }, snapshot);
    if (freshnessStatus === "stale") {
      results.push({
        rule: "stale-page",
        severity: "warning",
        file: page.filePath,
        message: `Page is stale — a source it was compiled from has changed since the last compile`,
      });
    } else if (freshnessStatus === "orphaned") {
      results.push({
        rule: "orphaned-page",
        severity: "warning",
        file: page.filePath,
        message: `Page is orphaned — every source it was compiled from has been deleted; recompile to clean it up`,
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
    const title = typeof meta.title === "string" ? meta.title : undefined;
    results.push(...checkPageEmpty({ title, body, filePath: page.filePath }));
  }

  return results;
}

/**
 * Pure per-page variant of {@link checkEmptyPages}: flag a titled page whose
 * body is empty or shorter than {@link MIN_BODY_LENGTH}. Operates on an
 * already-parsed `{ title, body, filePath }` so callers that hold a page's
 * content in memory (e.g. the profile-aware entity-page linter) can reuse the
 * exact same rule without re-reading or re-parsing frontmatter.
 *
 * @param page - The page's frontmatter title (if any), markdown body, and path.
 * @returns A single `empty-page` warning, or an empty array when not empty.
 */
export function checkPageEmpty(page: {
  title?: string;
  body: string;
  filePath: string;
}): LintResult[] {
  const hasTitle = typeof page.title === "string" && page.title.trim() !== "";
  const isBodyEmpty = page.body.trim().length < MIN_BODY_LENGTH;
  if (!hasTitle || !isBodyEmpty) return [];
  return [
    {
      rule: "empty-page",
      severity: "warning",
      file: page.filePath,
      message: `Page body is empty or too short (< ${MIN_BODY_LENGTH} chars)`,
    },
  ];
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
