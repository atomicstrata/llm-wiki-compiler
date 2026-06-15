/**
 * @file OKF reserved files: bundle-root index.md (only place with frontmatter) + log.md.
 *
 * `buildOkfIndex` generates the bundle's root `index.md` with an `okf_version`
 * frontmatter header and a Table of Contents grouped by page directory.
 * `buildOkfLog` serialises activity log entries (newest-first, bold action prefix).
 * `parseLlmwikiLog` translates llmwiki's `## [ISO] op | desc` headings into OKF entries.
 */
import type { ExportPage } from "../types.js";

/** A single activity entry for the OKF log.md. */
export interface OkfLogEntry { date: string; action: string; text: string; }

/** Bundle-root index.md: okf_version frontmatter + a TOC over concepts/ AND queries/. */
export function buildOkfIndex(pages: ExportPage[], paths: Map<ExportPage, string>): string {
  const entry = (p: ExportPage) => `* [${p.title}](/${paths.get(p)}) - ${p.summary}`;
  const concepts = pages.filter((p) => p.pageDirectory === "concepts").map(entry);
  const queries = pages.filter((p) => p.pageDirectory === "queries").map(entry);
  const sections: string[] = [];
  if (concepts.length) sections.push(`## Concepts\n\n${concepts.join("\n")}`);
  if (queries.length) sections.push(`## Queries\n\n${queries.join("\n")}`);
  return `---\nokf_version: "0.1"\n---\n\n# Knowledge Bundle\n\n${sections.join("\n\n")}\n`;
}

/**
 * OKF log.md: one `## YYYY-MM-DD` heading per date (newest first) with all of
 * that day's `* **Action** text` bullets grouped beneath it. Grouping (rather
 * than one heading per entry) keeps a future importer from dropping entries
 * that would otherwise sit under duplicate same-day headings.
 */
export function buildOkfLog(entries: OkfLogEntry[]): string {
  const bulletsByDate = new Map<string, string[]>();
  for (const e of entries) {
    const bullets = bulletsByDate.get(e.date) ?? [];
    bullets.push(`* **${e.action}** ${e.text}`);
    bulletsByDate.set(e.date, bullets);
  }
  const dates = [...bulletsByDate.keys()].sort((a, b) => (a < b ? 1 : -1));
  const body = dates
    .map((date) => `## ${date}\n\n${bulletsByDate.get(date)!.join("\n")}`)
    .join("\n\n");
  return `# Log\n\n${body}\n`;
}

const LOG_HEADING = /^##\s+\[(\d{4}-\d{2}-\d{2})T[^\]]*\]\s+([\w-]+)\s+\|\s+(.*)$/gm;

/** Parse llmwiki's activity log.md headings (`## [ISO] op | desc`) into OKF entries. */
export function parseLlmwikiLog(content: string): OkfLogEntry[] {
  const entries: OkfLogEntry[] = [];
  for (const m of content.matchAll(LOG_HEADING)) {
    const [, date, op, text] = m;
    entries.push({ date, action: op.charAt(0).toUpperCase() + op.slice(1), text: text.trim() });
  }
  return entries;
}
