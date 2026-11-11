/**
 * Wiki index generator.
 *
 * Scans all concept pages in wiki/concepts/, extracts frontmatter metadata,
 * and produces wiki/index.md with a sorted list of all concepts and their
 * summaries. Used after each compilation pass.
 *
 * `generateIndexFrom` is THE ONE BODY and holds no project root: it reaches the
 * project only through {@link IndexGenerationSources}, five operations this
 * module names itself, the last of which publishes the finished index.
 * `generateIndex(root)` is a delegate over a private binding built per call,
 * whose members call the same readers and the same atomic writer as before, at
 * the same points. Naming the operations selects no backend and rules on no
 * mechanism; every member of the local binding is still local disk.
 */

import path from "path";
import pLimit from "p-limit";
import { parseFrontmatter } from "../utils/markdown.js";
import { listDirectoryNames, replaceLeafAtomicWithin } from "../storage/disk-guarded-leaves.js";
import { readWikiPageInDir, warnDroppedWikiRead } from "./confined-wiki-read.js";
import type { ConfinedReadResult } from "./confined-wiki-read.js";
import { toPosixPath } from "../utils/path-confine.js";
import { CONCEPTS_DIR, QUERIES_DIR, INDEX_FILE } from "../utils/constants.js";
import * as output from "../utils/output.js";
import type { PageSummary } from "../utils/types.js";
import { loadNonDefaultProfile, collectEntityPagesWithMessages } from "../profile/block.js";
import type { EntityPage, LoadedProfile } from "../profile/types.js";

/**
 * Everything one index generation asks of the project, in the order
 * {@link generateIndexFrom} asks it. Each member is asked at most once, one
 * after another, never together. A member that rejects rejects the generation
 * with the same error, and nothing after it is asked.
 */
export interface IndexGenerationSources {
  /** FIRST. The concept index rows: titled, non-orphaned concept pages, unsorted. */
  conceptSummaries(): Promise<PageSummary[]>;
  /** SECOND. The saved-query index rows, unsorted. */
  querySummaries(): Promise<PageSummary[]>;
  /** THIRD. The active non-default profile; `undefined` for the built-in default. */
  loadProfile(): Promise<LoadedProfile | undefined>;
  /** FOURTH, and only for a non-default profile. Its promoted entity pages; only `pages` is used here. */
  collectEntityPages(loaded: LoadedProfile): Promise<{ pages: EntityPage[] }>;
  /**
   * LAST. Replace the project's index with `content`, the whole finished text.
   * On local disk this is the incumbent confined atomic replacement of
   * `wiki/index.md`. What a reader sees meanwhile, durability, locking and
   * recovery are the implementation's and are NOT promised by this member.
   */
  publishIndex(content: string): Promise<void>;
}

/**
 * LOCAL DISK. The index-generation sources for the project at `root`, built
 * per call and private to this module. Building them does no I/O and evaluates
 * nothing: each member calls its reader or the writer, with the path it always
 * had, only when asked.
 */
function diskIndexGenerationSources(root: string): IndexGenerationSources {
  return {
    conceptSummaries: () => collectPageSummaries(path.join(root, CONCEPTS_DIR)),
    querySummaries: () => collectPageSummaries(path.join(root, QUERIES_DIR)),
    loadProfile: () => loadNonDefaultProfile(root),
    collectEntityPages: (loaded) => collectEntityPagesWithMessages(root, loaded),
    publishIndex: (content) => replaceLeafAtomicWithin(root, path.join(root, INDEX_FILE), content),
  };
}

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
  return generateIndexFrom(diskIndexGenerationSources(root));
}

/**
 * {@link generateIndex} through `sources`: THE ONE BODY. Announce; concepts;
 * queries; sort both by title; the typed pages; render; publish; and only then
 * report success. A publication that rejects reports no success.
 */
export async function generateIndexFrom(sources: IndexGenerationSources): Promise<void> {
  output.status("*", output.info("Generating index..."));

  const concepts = await sources.conceptSummaries();
  const queries = await sources.querySummaries();

  concepts.sort((a, b) => a.title.localeCompare(b.title));
  queries.sort((a, b) => a.title.localeCompare(b.title));

  const entityPages = await collectTypedPages(sources);
  const indexContent = buildIndexContent(concepts, queries, entityPages);
  await sources.publishIndex(indexContent);

  // Typed pages are rendered in the index, so the count must include them too
  // (empty for a DEFAULT project → unchanged "concepts + queries" total).
  const total = concepts.length + queries.length + entityPages.length;
  output.status("+", output.success(`Index updated with ${total} pages.`));
}

/**
 * Collect the promoted typed entity pages for a NON-DEFAULT profile, or an empty
 * array for a DEFAULT project. Returns the path-confined `EntityPage`s the
 * collector already validated — nothing here re-reads or re-resolves a path.
 * @param sources - The generation's sources; the profile is loaded, then its pages collected.
 * @returns The non-default profile's entity pages, or `[]` for a default project.
 */
async function collectTypedPages(sources: IndexGenerationSources): Promise<EntityPage[]> {
  const loaded = await sources.loadProfile();
  if (loaded === undefined) return [];
  const { pages } = await sources.collectEntityPages(loaded);
  return pages;
}

/** A scanned page paired with its parsed frontmatter. */
export interface ScannedPage {
  slug: string;
  meta: Record<string, unknown>;
}

/**
 * The two reads a scan of ONE wiki page directory makes, named so that
 * {@link scanWikiPagesFrom} can run without a directory path. Naming them
 * selects no backend and rules on no mechanism.
 */
export interface WikiPageScanReads {
  /** Every name in the directory, in the backend's listing order. REJECTS when the directory cannot be listed. */
  listNames(): Promise<string[]>;
  /** One page's whole text confined to the directory, or why it was dropped. Reports nothing itself. */
  readPage(slug: string): Promise<ConfinedReadResult>;
}

/** LOCAL DISK. The scan reads for the directory at `dirPath`. Building them does no I/O. Exported for the status composition only; in no package index. */
export function diskWikiPageScanReads(dirPath: string): WikiPageScanReads {
  return {
    listNames: () => listDirectoryNames(dirPath),
    readPage: (slug) => readWikiPageInDir(dirPath, slug),
  };
}

/**
 * Scan a wiki directory and return every .md page paired with its parsed
 * frontmatter. Read-only utility shared by index generation and the MCP
 * server's status tool.
 * @param dirPath - Absolute path to a wiki page directory.
 * @returns Array of {slug, meta} entries — empty when the directory is missing.
 */
export async function scanWikiPages(dirPath: string): Promise<ScannedPage[]> {
  return scanWikiPagesFrom(diskWikiPageScanReads(dirPath));
}

/**
 * Page reads in flight at once. Each confined read is several dependent
 * syscalls (resolve, open, stat, re-check, read, close), so overlapping pages
 * hides that latency; the bound keeps a large wiki from exhausting descriptors.
 */
const PAGE_READ_CONCURRENCY = 32;

/**
 * {@link scanWikiPages} through `reads`: THE ONE BODY. One listing, then one
 * page read per `.md` name, up to {@link PAGE_READ_CONCURRENCY} at a time. The
 * result, and every dropped-page warning, stays in listing order. A listing
 * that rejects is an empty scan; a dropped page is warned about and skipped.
 */
export async function scanWikiPagesFrom(reads: WikiPageScanReads): Promise<ScannedPage[]> {
  let files: string[];
  try {
    files = await reads.listNames();
  } catch {
    return [];
  }

  // The scan directory is itself the confinement boundary: a symlinked entry
  // whose target escapes `dirPath` is dropped (warned, skipped) and never enters
  // the scan, keeping its bytes out of any index/summary derived from it.
  const slugs = files.filter((f) => f.endsWith(".md")).map((file) => file.replace(/\.md$/, ""));
  const limit = pLimit(PAGE_READ_CONCURRENCY);
  const results = await Promise.all(slugs.map((slug) => limit(() => reads.readPage(slug))));
  const scanned: ScannedPage[] = [];
  for (const [index, slug] of slugs.entries()) {
    const result = results[index];
    if (!("content" in result)) {
      warnDroppedWikiRead(`${slug}.md`, result.dropped); // dropped (symlink escape / fail-closed)
      continue;
    }
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
  return collectPageSummariesFrom(diskWikiPageScanReads(conceptsPath));
}

/** {@link collectPageSummaries} through `reads`: one {@link scanWikiPagesFrom}, then the titled, non-orphaned rows. */
export async function collectPageSummariesFrom(reads: WikiPageScanReads): Promise<PageSummary[]> {
  return summariesOf(await scanWikiPagesFrom(reads));
}

/** The index rows for scanned pages: titled, non-orphaned pages with their summaries. */
export function summariesOf(scanned: readonly ScannedPage[]): PageSummary[] {
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
 * The relative segment is forced back to POSIX: `path.relative` emits `path.sep`,
 * so on win32 a NESTED entity directory (`wiki/research/papers`) produced the
 * broken link `research\papers/foo.md` (issue #163, output-side instance).
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
      const link = `${toPosixPath(path.relative(WIKI_ROOT, page.directory))}/${page.slug}.md`;
      lines.push(`- **[${page.title ?? page.slug}](${link})** — \`${page.id}\``);
    }
  }
  return lines;
}
