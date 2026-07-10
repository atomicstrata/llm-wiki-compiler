/**
 * Marp slide export format writer.
 *
 * Produces a single Markdown file with Marp frontmatter that can be rendered
 * as a slide deck by the Marp CLI or VS Code Marp extension. Each wiki page
 * becomes one slide showing the title, summary, tags, sources, timestamps,
 * and an excerpt of the body (first paragraph, up to a readable limit).
 *
 * The caller may pre-filter pages by source directory ("concepts" |
 * "queries" | "all") using the --source option on the CLI.
 *
 * Reference: https://marp.app/
 */

import type { ExportPage, MarpSource } from "./types.js";
import { exportBodyText, exportFieldText } from "./connector-content.js";

/** Maximum characters of body text to include per slide. */
const SLIDE_BODY_MAX_CHARS = 300;

/** Extract the first prose paragraph from a markdown body. */
function extractFirstParagraph(body: string): string {
  const trimmed = body.trim();
  // Take the first non-empty block separated by a blank line.
  const firstBlock = trimmed.split(/\n\s*\n/)[0] ?? "";
  // Strip markdown headings and list markers so slides read cleanly.
  const stripped = firstBlock
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .trim();
  if (stripped.length <= SLIDE_BODY_MAX_CHARS) return stripped;
  return `${stripped.slice(0, SLIDE_BODY_MAX_CHARS)}…`;
}

/** Build the speaker-notes block for a slide containing metadata. */
function buildSpeakerNotes(page: ExportPage): string {
  const parts: string[] = [`created: ${page.createdAt}`, `updated: ${page.updatedAt}`];
  if (page.sources.length > 0) parts.push(`sources: ${page.sources.join(", ")}`);
  return `<!-- ${parts.join(" | ")} -->`;
}

/** Render one ExportPage as a Marp slide. */
function pageToSlide(page: ExportPage): string {
  const tagLine = page.tags.length > 0 ? `\n_Tags: ${page.tags.join(", ")}_` : "";
  const excerpt = extractFirstParagraph(exportBodyText(page));
  const summary = exportFieldText(page, "summary", page.summary);
  const notes = buildSpeakerNotes(page);
  return [
    `## ${page.title}`,
    "",
    `> ${summary}${tagLine}`,
    "",
    excerpt,
    "",
    notes,
  ].join("\n");
}

/**
 * Filter pages by the requested marp source directory.
 * "all" returns the full list unchanged.
 */
function filterBySource(pages: ExportPage[], source: MarpSource): ExportPage[] {
  if (source === "all") return pages;
  return pages.filter((p) => p.pageDirectory === source);
}

/**
 * Build the Marp slide deck content from a list of export pages.
 * @param pages - Array of all export pages.
 * @param projectTitle - Shown on the title slide.
 * @param source - Which page directories to include (default "all").
 * @returns Full Marp markdown string.
 */
export function buildMarp(
  pages: ExportPage[],
  projectTitle: string,
  source: MarpSource = "all",
): string {
  const filtered = filterBySource(pages, source);

  const frontmatter = [
    "---",
    "marp: true",
    "theme: default",
    "paginate: true",
    `title: "${projectTitle}"`,
    "---",
  ].join("\n");

  const titleSlide = [
    "",
    `# ${projectTitle}`,
    "",
    `${filtered.length} pages | ${new Date().toISOString()}`,
  ].join("\n");

  const slides = filtered.map((p) => `---\n\n${pageToSlide(p)}`);

  return [frontmatter, titleSlide, ...slides, ""].join("\n\n");
}
