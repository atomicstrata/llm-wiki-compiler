/**
 * llms.txt export format writer.
 *
 * Produces a machine-readable index per the llmstxt.org spec:
 *   - H1 project title
 *   - Optional blockquote description
 *   - H2-delimited sections per page directory (## Concepts, ## Saved Queries)
 *   - Bullet entries: [Title](path): summary | tags | sources | timestamps
 *
 * The companion llms-full.txt format appends the full body of every page
 * so a model can read the entire wiki in one file.
 *
 * Reference: https://llmstxt.org
 */

import type { ExportPage } from "./types.js";
import { exportBodyText, exportFieldText } from "./connector-content.js";

/**
 * Build the wiki-relative path for a page based on its source directory.
 * Concepts live in wiki/concepts/, queries in wiki/queries/.
 */
function pageRelativePath(page: ExportPage): string {
  return `wiki/${page.pageDirectory}/${page.slug}.md`;
}

/**
 * Build the inline note clause for a page entry.
 * Follows the colon after the markdown link per spec.
 */
function buildEntryNote(page: ExportPage): string {
  const parts: string[] = [];
  if (page.summary) parts.push(exportFieldText(page, "summary", page.summary));
  if (page.tags.length > 0) parts.push(`tags: ${page.tags.join(", ")}`);
  if (page.sources.length > 0) parts.push(`sources: ${page.sources.join(", ")}`);
  parts.push(`created: ${page.createdAt}`);
  parts.push(`updated: ${page.updatedAt}`);
  return parts.join(" | ");
}

/** Format a single page as a spec-compliant bullet entry. */
function formatPageEntry(page: ExportPage): string {
  const note = buildEntryNote(page);
  return `- [${page.title}](${pageRelativePath(page)}): ${note}`;
}

/** Build entries for a filtered subset of pages under an H2 section. */
function buildSection(heading: string, pages: ExportPage[]): string[] {
  if (pages.length === 0) return [];
  return [`## ${heading}`, "", ...pages.map(formatPageEntry), ""];
}

/**
 * Build the concise llms.txt index content per the llmstxt.org spec.
 * Pages are split into Concepts and Saved Queries sections (H2 delimited).
 * @param pages - Sorted array of export pages.
 * @param projectTitle - Human-readable wiki title shown as the H1.
 * @returns Full llms.txt string.
 */
export function buildLlmsTxt(pages: ExportPage[], projectTitle: string): string {
  const concepts = pages.filter((p) => p.pageDirectory === "concepts");
  const queries = pages.filter((p) => p.pageDirectory === "queries");

  const lines: string[] = [
    `# ${projectTitle}`,
    "",
    `> ${pages.length} pages — exported ${new Date().toISOString()}`,
    "",
    ...buildSection("Concepts", concepts),
    ...buildSection("Saved Queries", queries),
  ];

  return lines.join("\n");
}

/**
 * Build the full llms-full.txt content (index + full page bodies).
 * Each page is separated by a horizontal rule and includes its metadata block.
 * @param pages - Sorted array of export pages.
 * @param projectTitle - Human-readable wiki title shown as the H1.
 * @returns Full llms-full.txt string.
 */
export function buildLlmsFullTxt(pages: ExportPage[], projectTitle: string): string {
  const sections: string[] = [buildLlmsTxt(pages, projectTitle)];

  for (const page of pages) {
    const tags = page.tags.length > 0 ? `\nTags: ${page.tags.join(", ")}` : "";
    const sources = page.sources.length > 0 ? `\nSources: ${page.sources.join(", ")}` : "";
    const summary = exportFieldText(page, "summary", page.summary);
    const header = [
      "---",
      `## ${page.title}`,
      `> ${summary}${tags}${sources}`,
      `Created: ${page.createdAt} | Updated: ${page.updatedAt}`,
      "",
    ].join("\n");
    sections.push(`${header}\n${exportBodyText(page).trim()}\n`);
  }

  return sections.join("\n");
}
