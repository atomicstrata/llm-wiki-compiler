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

import { readdir, readFile, lstat, open } from "fs/promises";
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
 * The maximum number of leading bytes the metadata-only path reads when probing
 * for a complete `---\n…\n---` frontmatter block. 64 KiB comfortably holds any
 * realistic frontmatter; a block whose closing fence falls beyond this cap is
 * rare enough to justify the full-read fallback rather than a larger buffer.
 */
const FRONTMATTER_PREFIX_CAP_BYTES = 64 * 1024;

/** Build a `RawEntityScan` from already-parsed frontmatter status + a body. */
function scanFromParsed(
  filePath: string,
  stem: string,
  parsed: ReturnType<typeof parseFrontmatterStatus>,
  body: string,
): RawEntityScan {
  const { meta, hasFrontmatterBlock, malformedFrontmatter } = parsed;
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
 * Read only a bounded leading PREFIX of `filePath` (up to
 * {@link FRONTMATTER_PREFIX_CAP_BYTES}) via a single `fs.open` + bounded read,
 * returning its UTF-8 decoding alongside whether the whole file fit in the cap.
 * The metadata-only path uses this to avoid paying full-body I/O on every poll.
 */
async function readBoundedPrefix(filePath: string): Promise<{ text: string; complete: boolean }> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(FRONTMATTER_PREFIX_CAP_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, FRONTMATTER_PREFIX_CAP_BYTES, 0);
    return { text: buffer.toString("utf-8", 0, bytesRead), complete: bytesRead < FRONTMATTER_PREFIX_CAP_BYTES };
  } finally {
    await handle.close();
  }
}

/** The two byte sequences a frontmatter block can open with (LF and CRLF). */
const FRONTMATTER_OPENINGS = ["---\n", "---\r\n"] as const;

/**
 * True when `text` begins with a frontmatter opening fence (`---\n`/`---\r\n`).
 * A prefix that does NOT begin with one cannot contain a frontmatter block at
 * all — the opening must be the very first bytes — so this alone is decisive.
 */
function startsWithFrontmatterOpening(text: string): boolean {
  return FRONTMATTER_OPENINGS.some((opening) => text.startsWith(opening));
}

/**
 * Metadata-only read: parse frontmatter from a bounded prefix WITHOUT reading
 * the whole file. Returns a body-less scan when the file CANNOT have frontmatter
 * (the prefix does not open with `---\n`/`---\r\n`), when a COMPLETE frontmatter
 * block is decided within the prefix, or when the prefix is complete; returns
 * `null` only when the closing fence is not yet visible AND the file exceeds the
 * cap, signalling the caller to fall back to a full read so behaviour is never wrong.
 *
 * The no-frontmatter early return reuses the same `parseFrontmatterStatus`
 * builder as every other path, so its `meta`/`parseStatus` are BYTE-IDENTICAL to
 * a full read of a file with no leading frontmatter — and a multi-MB body that
 * does not open with a fence is summarized from the small prefix, never read whole.
 */
async function readMetadataOnlyScan(filePath: string, stem: string): Promise<RawEntityScan | null> {
  const { text, complete } = await readBoundedPrefix(filePath);
  const parsed = parseFrontmatterStatus(text);
  // Not opening with a fence is already decisive: there is no frontmatter, so
  // the rest of the file is irrelevant and need not be read.
  if (!startsWithFrontmatterOpening(text)) return scanFromParsed(filePath, stem, parsed, "");
  // A complete prefix is authoritative. A truncated prefix is only trustworthy
  // when a closing fence was already found — otherwise the real block may close
  // past the cap, so we must fall back to the full read.
  if (complete || parsed.hasFrontmatterBlock) return scanFromParsed(filePath, stem, parsed, "");
  return null;
}

/**
 * Read one confirmed-confined `.md` file into a `RawEntityScan`. Returns null
 * only when the file cannot be read; every parse-level problem (missing
 * frontmatter, malformed YAML, missing title, orphaned flag) is preserved as
 * a `parseStatus` flag so callers decide. The `stem` is passed through raw.
 *
 * When `includeBody` is true the whole file is read. When false (count-only
 * callers), a bounded frontmatter-only prefix read is attempted first so a large
 * project's bodies are never read or held in memory just to tally; the produced
 * `meta`/`parseStatus` are BYTE-IDENTICAL to the full-read path, and a file
 * whose frontmatter exceeds the prefix cap transparently falls back to a full
 * read so behaviour is never wrong.
 */
async function readEntityScan(
  filePath: string,
  stem: string,
  includeBody: boolean,
): Promise<RawEntityScan | null> {
  if (!includeBody) {
    try {
      const metadataScan = await readMetadataOnlyScan(filePath, stem);
      if (metadataScan) return metadataScan;
    } catch {
      return null;
    }
  }
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  const parsed = parseFrontmatterStatus(raw);
  return scanFromParsed(filePath, stem, parsed, includeBody ? parsed.body : "");
}

/**
 * Confinement classification of an entity directory:
 *   - `ok`      — the directory resolves to its exact expected canonical path;
 *   - `missing` — the directory does not exist (readdir ENOENT);
 *   - `invalid` — the root realpath failed, OR the directory's realpath differs
 *     from its expected path (a symlinked / confinement-failed directory).
 *
 * The default collector ignores this and treats `missing`/`invalid` as empty;
 * the non-default collector surfaces `invalid` as a problem so a partial
 * project is never presented as healthy.
 */
export type EntityDirStatus = "ok" | "missing" | "invalid";

/** Result of one entity-directory scan: the readable scans plus dir status. */
export interface EntityDirScan {
  scans: RawEntityScan[];
  dirStatus: EntityDirStatus;
}

/** Options for {@link scanEntityDir}. */
export interface ScanEntityDirOptions {
  /**
   * When true (the default), each scan retains its markdown body. When false,
   * frontmatter is still parsed but the body is dropped (`body: ""`) so a
   * count-only caller never holds O(total bytes) of page content in memory.
   */
  includeBody?: boolean;
}

/**
 * The SINGLE raw directory scanner shared by the default and profile-aware
 * collectors. Walks one entity directory and returns one `RawEntityScan` per
 * readable `.md` file (stem VERBATIM, no slugify), plus a `dirStatus` that
 * distinguishes an INVALID (symlinked / confinement-failed) directory from a
 * benignly ABSENT one.
 *
 * Confinement is stricter than "stays under project root": `root` is
 * canonicalized via `realpath`, the directory itself must resolve to the exact
 * expected path under that canonical root (so a symlinked entity dir is flagged
 * `invalid` even when its target is in-root), and each `.md` entry must resolve
 * under that canonical directory (so a symlinked `x.md` pointing elsewhere is
 * dropped). A root realpath failure or a mismatched directory realpath is
 * `invalid` (empty scans); an ENOENT readdir is `missing` (empty scans).
 *
 * @param root - Project root (raw; canonicalized internally).
 * @param dir - Repo-relative directory for this entity type (e.g. `wiki/concepts`).
 * @param opts - When `includeBody` is false, bodies are dropped for a count-only
 *   scan; defaults to retaining bodies so existing callers are byte-unchanged.
 */
export async function scanEntityDir(
  root: string,
  dir: string,
  opts: ScanEntityDirOptions = {},
): Promise<EntityDirScan> {
  const includeBody = opts.includeBody ?? true;
  const canonicalRoot = await safeRealpath(root);
  if (!canonicalRoot) return { scans: [], dirStatus: "invalid" };
  const expectedDir = path.join(canonicalRoot, dir);
  const dirStatus = await classifyEntityDir(expectedDir);
  if (dirStatus !== "ok") return { scans: [], dirStatus };
  let files: string[];
  try {
    files = await readdir(expectedDir);
  } catch {
    return { scans: [], dirStatus: "missing" };
  }
  const scans: RawEntityScan[] = [];
  for (const file of files.filter((f) => f.endsWith(".md"))) {
    const resolved = await safeRealpath(path.join(expectedDir, file));
    if (!resolved || !isInsideDir(resolved, expectedDir)) continue;
    const scan = await readEntityScan(resolved, file.replace(/\.md$/, ""), includeBody);
    if (scan) scans.push(scan);
  }
  return { scans, dirStatus: "ok" };
}

/**
 * Classify an entity directory at its EXPECTED canonical path:
 *   - the path does not exist at all (lstat ENOENT) → `missing` (benign);
 *   - it exists but its realpath differs from the expected path (a symlink, or
 *     a confinement failure) → `invalid`;
 *   - otherwise → `ok`.
 *
 * Distinguishing absent from invalid lets the non-default collector surface a
 * symlinked directory as a problem while treating a missing directory as an
 * empty (but healthy) entity type.
 */
async function classifyEntityDir(expectedDir: string): Promise<EntityDirStatus> {
  try {
    await lstat(expectedDir);
  } catch {
    return "missing";
  }
  const realDir = await safeRealpath(expectedDir);
  return realDir === expectedDir ? "ok" : "invalid";
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
    scanEntityDir(root, CONCEPTS_DIR),
    scanEntityDir(root, QUERIES_DIR),
  ]);
  // The default path ignores dirStatus: a missing OR invalid dir is treated as
  // empty, exactly as before the refactor (the parity golden proves this).
  return [
    ...concepts.scans.map((s) => scanToRawWikiPage(s, "concepts")),
    ...queries.scans.map((s) => scanToRawWikiPage(s, "queries")),
  ];
}
