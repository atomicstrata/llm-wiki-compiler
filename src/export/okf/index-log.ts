/**
 * @file OKF reserved files: bundle-root index.md (only place with frontmatter) + log.md.
 *
 * `buildOkfIndex` generates the bundle's root `index.md` with an `okf_version`
 * frontmatter header and a Table of Contents grouped by page directory.
 * `buildOkfLog` serialises activity log entries (newest-first, bold action prefix).
 * `parseLlmwikiLog` translates llmwiki's `## [ISO] op | desc` headings into OKF entries.
 */
import type { ExportPage } from "../types.js";
import type { ProfileEntityDoc } from "./profile-docs.js";
import type { BundleBlock } from "./bundle-block.js";
import { buildFrontmatter } from "../../utils/markdown.js";

/** The OKF bundle format version stamped on `index.md` frontmatter. */
const OKF_VERSION = "0.1";

/** A single activity entry for the OKF log.md. */
export interface OkfLogEntry { date: string; action: string; text: string; }

/** Upper-case the first character for a section heading (`papers` -> `Papers`). */
function capitalize(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * One `## <Type>` TOC section per entity type that has docs, ALPHABETICAL by
 * entity type, emitted after the Concepts/Queries sections. An empty
 * `entityDocs` yields no sections, so a default-profile bundle's index.md is
 * byte-identical to a pre-7.6 export (D-7.6.10).
 */
function entityTocSections(entityDocs: ProfileEntityDoc[]): string[] {
  const byType = new Map<string, ProfileEntityDoc[]>();
  for (const doc of entityDocs) {
    const list = byType.get(doc.entityType) ?? [];
    list.push(doc);
    byType.set(doc.entityType, list);
  }
  return [...byType.keys()].sort().map((type) => {
    const items = byType.get(type)!.map((d) => `* [${d.title}](/${d.rel}) - ${d.summary}`);
    return `## ${capitalize(type)}\n\n${items.join("\n")}`;
  });
}

/**
 * Render the `index.md` frontmatter. A default-profile bundle (no `bundleBlock`)
 * keeps the exact `okf_version`-only header — byte-identical to a pre-7.6 export
 * (D-7.6.10). A non-default project additionally carries the reserved
 * `x-llmwiki` bundle metadata block (D-7.6.1), serialized via the shared YAML
 * frontmatter builder.
 */
function renderIndexFrontmatter(bundleBlock: BundleBlock | undefined): string {
  if (bundleBlock === undefined) return `---\nokf_version: "${OKF_VERSION}"\n---`;
  return buildFrontmatter({ okf_version: OKF_VERSION, "x-llmwiki": bundleBlock });
}

/** Bundle-root index.md: okf_version (+ optional x-llmwiki) frontmatter + a TOC over concepts/, queries/, and each entity type. */
export function buildOkfIndex(
  pages: ExportPage[],
  paths: Map<ExportPage, string>,
  entityDocs: ProfileEntityDoc[] = [],
  bundleBlock?: BundleBlock,
): string {
  const entry = (p: ExportPage) => `* [${p.title}](/${paths.get(p)}) - ${p.summary}`;
  const concepts = pages.filter((p) => p.pageDirectory === "concepts").map(entry);
  const queries = pages.filter((p) => p.pageDirectory === "queries").map(entry);
  const sections: string[] = [];
  if (concepts.length) sections.push(`## Concepts\n\n${concepts.join("\n")}`);
  if (queries.length) sections.push(`## Queries\n\n${queries.join("\n")}`);
  sections.push(...entityTocSections(entityDocs));
  return `${renderIndexFrontmatter(bundleBlock)}\n\n# Knowledge Bundle\n\n${sections.join("\n\n")}\n`;
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
