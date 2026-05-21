/**
 * Shared low-level wiki page collector.
 *
 * Walks `wiki/concepts/` and `wiki/queries/`, derives the slug from each
 * filename stem (NOT through `slugify()` — filename slugs are the canonical
 * filesystem-truth identifier; slugifying them would shift routes, exports,
 * and citation lookups), parses frontmatter via `parseFrontmatterStatus`,
 * and returns one `RawWikiPage` per readable `.md` file with a `parseStatus`
 * field describing structural problems.
 *
 * Content semantics: this layer does not drop pages for parse-level
 * failures (missing frontmatter, malformed YAML, missing title, orphaned
 * flag). Those are surfaced as `parseStatus` flags so the caller decides.
 *
 * Path-safety: this layer DOES drop entries that fail confinement to
 * their expected canonical directory. Specifically — a symlinked
 * `wiki/concepts/` directory (even pointing in-root), a symlinked
 * `.md` file whose `realpath` resolves anywhere other than under the
 * expected concepts/queries directory, and any unreadable entry — are
 * silently excluded. Two callers consume it:
 *
 *   - `src/export/collect.ts` filters on `parseStatus.orphaned` and
 *     `parseStatus.hasTitle` to preserve the existing export semantics.
 *   - `src/viewer/collect.ts` retains every record and maps `parseStatus`
 *     flags into `ViewerWarning` objects so users can diagnose malformed
 *     pages in the UI.
 */

import { readdir, readFile, realpath } from "fs/promises";
import path from "path";
import { parseFrontmatterStatus, slugify } from "../utils/markdown.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import type { PageDirectory } from "../export/types.js";

/** Regex that matches `[[wikilink]]` or `[[wikilink|alias]]` patterns. */
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/**
 * Structural status of a single page's frontmatter, surfaced to callers so
 * they can decide whether to filter, warn, or pass through.
 */
interface RawPageParseStatus {
  /** True when the file begins with a `---\n…\n---` block. */
  hasFrontmatterBlock: boolean;
  /** True when the frontmatter block exists but YAML failed to parse. */
  malformedFrontmatter: boolean;
  /** True when frontmatter contains a non-empty string `title`. */
  hasTitle: boolean;
  /** True when frontmatter explicitly sets `orphaned: true`. */
  orphaned: boolean;
}

/**
 * Raw page record returned by the shared collector. Lower-level than
 * `ExportPage` or `ViewerPage`: no decoration, no filtering, no warnings.
 */
export interface RawWikiPage {
  /** Filename stem (filename without the trailing `.md`). */
  slug: string;
  /** Which wiki/ subdirectory the page came from. */
  pageDirectory: PageDirectory;
  /** Absolute path on disk, useful for diagnostics and editor links. */
  filePath: string;
  /** Title from frontmatter when present; undefined otherwise. */
  title?: string;
  /** Parsed frontmatter (empty object when missing or malformed). */
  frontmatter: Record<string, unknown>;
  /** Markdown body with the frontmatter block stripped. */
  body: string;
  /** Structural status flags consumed by export and viewer callers. */
  parseStatus: RawPageParseStatus;
}

/**
 * Extract the slugs of all pages linked via `[[wikilinks]]` in the body.
 * Wikilink targets ARE slugified — the human-typed link text may not match
 * the on-disk filename verbatim, so we normalize to the same shape `slugify`
 * produces. Returns deduplicated targets.
 */
export function extractWikilinkSlugs(body: string): string[] {
  const slugs = new Set<string>();
  WIKILINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_RE.exec(body)) !== null) {
    slugs.add(slugify(match[1].trim()));
  }
  return [...slugs];
}

/**
 * Like `extractWikilinkSlugs` but also preserves the original human-typed
 * text for each target. Used to give dangling-link ghost nodes a readable
 * title instead of a slugified identifier.
 */
export function extractWikilinkTargets(body: string): { slug: string; display: string }[] {
  const seen = new Set<string>();
  const targets: { slug: string; display: string }[] = [];
  WIKILINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_RE.exec(body)) !== null) {
    const target = match[1].trim();
    const alias = match[2]?.trim();
    const slug = slugify(target);
    const display = alias ?? target;
    if (!seen.has(slug)) {
      seen.add(slug);
      targets.push({ slug, display });
    }
  }
  return targets;
}

/**
 * `realpath` wrapper that returns null instead of throwing on missing
 * files. Used everywhere we resolve a possibly-absent or possibly-broken
 * symlink and want to fall through to "skip this entry."
 */
async function safeRealpath(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/** True when `child` equals `dir` or sits beneath it. */
function isInsideDir(child: string, dir: string): boolean {
  if (child === dir) return true;
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return child.startsWith(prefix);
}

/**
 * Parse a single markdown file into a `RawWikiPage`. Returns null only when
 * the file cannot be read — every other failure mode (missing frontmatter,
 * malformed YAML, missing title, orphaned flag) is preserved as a
 * `parseStatus` flag so the caller decides how to handle it.
 */
async function parsePageFile(
  filePath: string,
  slug: string,
  pageDirectory: PageDirectory,
): Promise<RawWikiPage | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  const { meta, body, hasFrontmatterBlock, malformedFrontmatter } = parseFrontmatterStatus(raw);
  const title = typeof meta.title === "string" && meta.title.length > 0 ? meta.title : undefined;
  return {
    slug,
    pageDirectory,
    filePath,
    title,
    frontmatter: meta,
    body,
    parseStatus: {
      hasFrontmatterBlock,
      malformedFrontmatter,
      hasTitle: title !== undefined,
      orphaned: meta.orphaned === true,
    },
  };
}

/**
 * Collect every readable `.md` file from a single wiki subdirectory.
 *
 * Confinement is stricter than "stays under project root": the
 * directory itself must resolve via `realpath` to the exact expected
 * path under `canonicalRoot` (so a symlinked `wiki/concepts/` is
 * skipped wholesale even when its target is also inside the project),
 * and each `.md` entry must resolve to a path under that canonical
 * expected directory (so a symlinked `wiki/concepts/leak.md` pointing
 * at `<root>/README.md` or `<root>/wiki/queries/x.md` is dropped).
 */
async function collectFromDir(
  canonicalRoot: string,
  pageDirectory: PageDirectory,
  subdir: string,
): Promise<RawWikiPage[]> {
  const expectedDir = path.join(canonicalRoot, subdir);
  const realDir = await safeRealpath(expectedDir);
  if (realDir !== expectedDir) return [];
  let files: string[];
  try {
    files = await readdir(realDir);
  } catch {
    return [];
  }
  const pages: RawWikiPage[] = [];
  for (const file of files.filter((f) => f.endsWith(".md"))) {
    const candidate = path.join(realDir, file);
    const resolved = await safeRealpath(candidate);
    if (!resolved || !isInsideDir(resolved, realDir)) continue;
    const slug = file.replace(/\.md$/, "");
    const page = await parsePageFile(resolved, slug, pageDirectory);
    if (page) pages.push(page);
  }
  return pages;
}

/**
 * Collect all readable wiki pages from `wiki/concepts/` and `wiki/queries/`.
 * Entries dropped for path-safety reasons (see `collectFromDir`) are
 * silently excluded. Pages are returned in filesystem order within each
 * directory, with concepts before queries; callers that need a stable
 * total order should sort.
 */
export async function collectRawWikiPages(root: string): Promise<RawWikiPage[]> {
  const canonicalRoot = await safeRealpath(root);
  if (!canonicalRoot) return [];
  const [concepts, queries] = await Promise.all([
    collectFromDir(canonicalRoot, "concepts", CONCEPTS_DIR),
    collectFromDir(canonicalRoot, "queries", QUERIES_DIR),
  ]);
  return [...concepts, ...queries];
}
