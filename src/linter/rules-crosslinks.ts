/**
 * Schema cross-link lint rules.
 *
 * Enforces the per-kind `minWikilinks` minimums declared in the project schema:
 * each page resolves to a kind, and a page whose body carries fewer
 * `[[wikilinks]]` than its kind requires warns. The on-disk walker
 * ({@link checkSchemaCrossLinks}) fans the pure per-page helper
 * ({@link checkPageCrossLinks}) across every page, and that same per-page helper
 * is reused by the review pipeline to attach schema violations to a candidate at
 * write time. Re-exported through {@link file://./rules.ts}.
 */

import { parseFrontmatter } from "../utils/markdown.js";
import type { LintResult } from "./types.js";
import {
  countWikilinks,
  resolvePageKind,
  type SchemaConfig,
} from "../schema/index.js";
import { collectAllPages } from "./rules-shared.js";

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
