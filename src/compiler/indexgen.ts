/**
 * Wiki index generator.
 *
 * Scans all concept pages in wiki/concepts/, extracts frontmatter metadata,
 * and produces wiki/index.md with a sorted list of all concepts and their
 * summaries. Used after each compilation pass.
 */

import { readdir } from "fs/promises";
import path from "path";
import { atomicWrite, parseFrontmatter } from "../utils/markdown.js";
import { readWikiPageInDirOrWarn } from "./confined-wiki-read.js";
import { CONCEPTS_DIR, QUERIES_DIR, INDEX_FILE } from "../utils/constants.js";
import * as output from "../utils/output.js";
import type { PageSummary } from "../utils/types.js";
import { loadNonDefaultProfile, collectEntityPagesWithMessages } from "../profile/block.js";
import type { EntityPage } from "../profile/types.js";

/**
 * Generate the wiki/index.md listing all concept pages with summaries.
 *
 * For a NON-DEFAULT profile project this ADDITIVELY appends one section per
 * declared entity type, enumerating each promoted typed page with a link to
 * `<entityType>/<slug>.md`. For a DEFAULT project (no profile.json) the index is
 * built byte-identically to before — the typed sections only ever appear when a
 * non-default profile is active.
 *
 * @param root - Project root directory.
 */
export async function generateIndex(root: string): Promise<void> {
  output.status("*", output.info("Generating index..."));

  const conceptsPath = path.join(root, CONCEPTS_DIR);
  const queriesPath = path.join(root, QUERIES_DIR);
  const concepts = await collectPageSummaries(conceptsPath);
  const queries = await collectPageSummaries(queriesPath);

  concepts.sort((a, b) => a.title.localeCompare(b.title));
  queries.sort((a, b) => a.title.localeCompare(b.title));

  const entityPages = await collectTypedPages(root);
  const indexContent = buildIndexContent(concepts, queries, entityPages);
  const indexPath = path.join(root, INDEX_FILE);
  await atomicWrite(indexPath, indexContent, { confineRoot: root });

  // Typed pages are rendered in the index, so the count must include them too
  // (empty for a DEFAULT project → unchanged "concepts + queries" total).
  const total = concepts.length + queries.length + entityPages.length;
  output.status("+", output.success(`Index updated with ${total} pages.`));
}

/**
 * Collect the promoted typed entity pages for a NON-DEFAULT profile, or an empty
 * array for a DEFAULT project. Returns the path-confined `EntityPage`s the
 * collector already validated — nothing here re-reads or re-resolves a path.
 * @param root - Project root directory.
 * @returns The non-default profile's entity pages, or `[]` for a default project.
 */
async function collectTypedPages(root: string): Promise<EntityPage[]> {
  const loaded = await loadNonDefaultProfile(root);
  if (loaded === undefined) return [];
  const { pages } = await collectEntityPagesWithMessages(root, loaded);
  return pages;
}

/** A scanned page paired with its parsed frontmatter. */
interface ScannedPage {
  slug: string;
  meta: Record<string, unknown>;
}

/**
 * Scan a wiki directory and return every .md page paired with its parsed
 * frontmatter. Read-only utility shared by index generation and the MCP
 * server's status tool.
 * @param dirPath - Absolute path to a wiki page directory.
 * @returns Array of {slug, meta} entries — empty when the directory is missing.
 */
export async function scanWikiPages(dirPath: string): Promise<ScannedPage[]> {
  let files: string[];
  try {
    files = await readdir(dirPath);
  } catch {
    return [];
  }

  // The scan directory is itself the confinement boundary: a symlinked entry
  // whose target escapes `dirPath` is dropped (warned, skipped) and never enters
  // the scan, keeping its bytes out of any index/summary derived from it.
  const scanned: ScannedPage[] = [];
  for (const file of files.filter((f) => f.endsWith(".md"))) {
    const slug = file.replace(/\.md$/, "");
    const result = await readWikiPageInDirOrWarn(dirPath, slug);
    if (!("content" in result)) continue; // dropped (symlink escape / fail-closed)
    const { meta } = parseFrontmatter(result.content);
    scanned.push({ slug, meta });
  }
  return scanned;
}

/**
 * Project a wiki directory into PageSummary entries (excludes orphaned and
 * untitled pages). Built on top of scanWikiPages so the MCP server can share
 * the underlying scan logic without re-reading the directory.
 * @param conceptsPath - Absolute path to wiki/concepts/.
 * @returns Array of page summary objects.
 */
export async function collectPageSummaries(
  conceptsPath: string,
): Promise<PageSummary[]> {
  const scanned = await scanWikiPages(conceptsPath);
  return scanned
    .filter(({ meta }) => meta.title && typeof meta.title === "string" && !meta.orphaned)
    .map(({ slug, meta }) => ({
      title: meta.title as string,
      slug,
      summary: typeof meta.summary === "string" ? meta.summary : "",
    }));
}

/** Strip [[wikilink]] brackets from text, leaving the inner text intact. */
function stripWikilinks(text: string): string {
  return text.replace(/\[\[([^\]]+)\]\]/g, "$1");
}

/**
 * Build the index.md markdown content from page summaries.
 *
 * The concepts/queries/footer rendering is UNCHANGED — when `entityPages` is
 * empty (every DEFAULT project) the output is byte-identical to before. Typed
 * entity sections are appended only when a non-default profile supplied pages.
 *
 * @param concepts - Sorted concept page summaries.
 * @param queries - Sorted saved-query page summaries.
 * @param entityPages - Non-default profile entity pages (empty for defaults).
 * @returns Full index.md content string.
 */
function buildIndexContent(
  concepts: PageSummary[],
  queries: PageSummary[],
  entityPages: EntityPage[] = [],
): string {
  const lines = ["# Knowledge Wiki", "", "## Concepts", ""];

  for (const page of concepts) {
    lines.push(`- **[[${page.slug}|${page.title}]]** — ${stripWikilinks(page.summary)}`);
  }

  if (queries.length > 0) {
    lines.push("", "## Saved Queries", "");
    for (const page of queries) {
      lines.push(`- **[[${page.slug}|${page.title}]]** — ${stripWikilinks(page.summary)}`);
    }
  }

  lines.push(...buildEntitySections(entityPages));

  // Footer count mirrors what's rendered: concepts + queries + typed pages.
  // entityPages is empty for DEFAULT projects, keeping that footer byte-identical.
  const total = concepts.length + queries.length + entityPages.length;
  lines.push("");
  lines.push(`_${total} pages | Generated ${new Date().toISOString()}_`);
  lines.push("");

  return lines.join("\n");
}

/**
 * The wiki root the index lives in (`wiki`), derived from {@link INDEX_FILE}
 * (`wiki/index.md`). Entity-page links are relativized against this so a link
 * stays correct relative to the index regardless of the configured wiki root.
 */
const WIKI_ROOT = path.dirname(INDEX_FILE);

/** Capitalize an entity type for a section heading (e.g. `papers` → `Papers`). */
function entityTypeHeading(entityType: string): string {
  return entityType.charAt(0).toUpperCase() + entityType.slice(1);
}

/**
 * Render one additive markdown section per entity type, each listing its typed
 * pages with a link to `<entityType>/<slug>.md` (relative to the index, which
 * lives in `wiki/`). Pages are grouped by type and sorted by slug for stable
 * output. Returns `[]` for a default project so the footer rendering is unchanged.
 *
 * The link target is derived from the page's already-confined `directory`/`slug`
 * (relativized against `wiki/`), so this only renders what the collector validated.
 *
 * @param entityPages - The non-default profile's collected entity pages.
 * @returns The markdown lines for the typed sections (empty when no pages).
 */
function buildEntitySections(entityPages: EntityPage[]): string[] {
  if (entityPages.length === 0) return [];
  const byType = new Map<string, EntityPage[]>();
  for (const page of entityPages) {
    const group = byType.get(page.entityType) ?? [];
    group.push(page);
    byType.set(page.entityType, group);
  }

  const lines: string[] = [];
  for (const entityType of [...byType.keys()].sort()) {
    const pages = byType.get(entityType)!.sort((a, b) => a.slug.localeCompare(b.slug));
    lines.push("", `## ${entityTypeHeading(entityType)}`, "");
    for (const page of pages) {
      const link = `${path.relative(WIKI_ROOT, page.directory)}/${page.slug}.md`;
      lines.push(`- **[${page.title ?? page.slug}](${link})** — \`${page.id}\``);
    }
  }
  return lines;
}
