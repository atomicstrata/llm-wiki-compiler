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

import { readdir, readFile } from "fs/promises";
import path from "path";
import { parseFrontmatterStatus, slugify } from "../utils/markdown.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import type { PageDirectory } from "../export/types.js";
import { safeRealpath, isInsideDir } from "../utils/path-confine.js";

/** Regex that matches `[[wikilink]]` or `[[wikilink|alias]]` patterns. */
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/**
 * Structural status of a single page's frontmatter, surfaced to callers so
 * they can decide whether to filter, warn, or pass through.
 */
export interface RawPageParseStatus {
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
 * One raw, untyped scan record per readable `.md` file in an entity
 * directory. The `stem` is the filename minus `.md`, returned VERBATIM —
 * never slugified, never grammar-checked. This is the lowest-level shared
 * primitive; identity validation/minting (for non-default profiles) and the
 * default `RawWikiPage` mapping are both built on top of it.
 */
export interface RawEntityScan {
  /** Filename stem (basename minus a trailing `.md`), raw and unchanged. */
  stem: string;
  /** Absolute, realpath-confined path to the `.md` file on disk. */
  filePath: string;
  /** Parsed frontmatter (empty object when missing or malformed). */
  frontmatter: Record<string, unknown>;
  /** Markdown body with the frontmatter block stripped. */
  body: string;
  /** Structural status flags consumed by the default mapping and callers. */
  parseStatus: RawPageParseStatus;
}

/**
 * Read one confirmed-confined `.md` file into a `RawEntityScan`. Returns null
 * only when the file cannot be read; every parse-level problem (missing
 * frontmatter, malformed YAML, missing title, orphaned flag) is preserved as
 * a `parseStatus` flag so callers decide. The `stem` is passed through raw.
 */
async function readEntityScan(filePath: string, stem: string): Promise<RawEntityScan | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  const { meta, body, hasFrontmatterBlock, malformedFrontmatter } = parseFrontmatterStatus(raw);
  const title = typeof meta.title === "string" && meta.title.length > 0;
  return {
    stem,
    filePath,
    frontmatter: meta,
    body,
    parseStatus: { hasFrontmatterBlock, malformedFrontmatter, hasTitle: title, orphaned: meta.orphaned === true },
  };
}

/**
 * The SINGLE raw directory scanner shared by the default and profile-aware
 * collectors. Walks one entity directory and returns one `RawEntityScan` per
 * readable `.md` file with its stem VERBATIM (no slugify, no grammar check).
 *
 * Confinement is stricter than "stays under project root": `root` is
 * canonicalized via `realpath`, the directory itself must resolve to the exact
 * expected path under that canonical root (so a symlinked entity dir is skipped
 * wholesale even when its target is in-root), and each `.md` entry must resolve
 * under that canonical directory (so a symlinked `x.md` pointing elsewhere is
 * dropped). Unreadable roots/dirs yield an empty array.
 *
 * @param root - Project root (raw; canonicalized internally).
 * @param entityType - Entity type name, for caller context only (not used in scanning).
 * @param dir - Repo-relative directory for this entity type (e.g. `wiki/concepts`).
 */
export async function scanEntityDir(
  root: string,
  entityType: string,
  dir: string,
): Promise<RawEntityScan[]> {
  void entityType;
  const canonicalRoot = await safeRealpath(root);
  if (!canonicalRoot) return [];
  const expectedDir = path.join(canonicalRoot, dir);
  const realDir = await safeRealpath(expectedDir);
  if (realDir !== expectedDir) return [];
  let files: string[];
  try {
    files = await readdir(realDir);
  } catch {
    return [];
  }
  const scans: RawEntityScan[] = [];
  for (const file of files.filter((f) => f.endsWith(".md"))) {
    const resolved = await safeRealpath(path.join(realDir, file));
    if (!resolved || !isInsideDir(resolved, realDir)) continue;
    const scan = await readEntityScan(resolved, file.replace(/\.md$/, ""));
    if (scan) scans.push(scan);
  }
  return scans;
}

/**
 * Map a raw scan to the default-pipeline `RawWikiPage` shape. The scan's raw
 * `stem` becomes the page `slug` BYTE-FOR-BYTE — never slugified — because
 * filename stems are the canonical filesystem-truth identifier on the default
 * path. The default pipeline never mints an `EntityId`.
 */
function scanToRawWikiPage(scan: RawEntityScan, pageDirectory: PageDirectory): RawWikiPage {
  const title = scan.parseStatus.hasTitle ? (scan.frontmatter.title as string) : undefined;
  return {
    slug: scan.stem,
    pageDirectory,
    filePath: scan.filePath,
    title,
    frontmatter: scan.frontmatter,
    body: scan.body,
    parseStatus: scan.parseStatus,
  };
}

/**
 * Collect all readable wiki pages from `wiki/concepts/` and `wiki/queries/`.
 * Entries dropped for path-safety reasons (see `scanEntityDir`) are silently
 * excluded. Pages are returned in filesystem order within each directory, with
 * concepts before queries; callers that need a stable total order should sort.
 *
 * Slug values are the raw filename stems VERBATIM — this path never calls
 * `entityId()` or `slugify()`.
 */
export async function collectRawWikiPages(root: string): Promise<RawWikiPage[]> {
  const [concepts, queries] = await Promise.all([
    scanEntityDir(root, "concepts", CONCEPTS_DIR),
    scanEntityDir(root, "queries", QUERIES_DIR),
  ]);
  return [
    ...concepts.map((s) => scanToRawWikiPage(s, "concepts")),
    ...queries.map((s) => scanToRawWikiPage(s, "queries")),
  ];
}
