/**
 * Path-safe page access primitives for the llmwiki in-process SDK.
 *
 * Exposes two public functions:
 *   - `getPage(root, ref)` — fetch a single page by directory + slug; returns
 *     the full `Page` shape (body included) or null when the file is absent.
 *   - `listPages(root, options)` — scan both page directories, read each page's
 *     body so wikilinks can be extracted, apply archive/orphan filters, sort,
 *     and return a cursor-paged slice.
 *
 * Design notes:
 *   - `links` are derived from the Markdown **body** via `extractWikilinkSlugs`,
 *     NOT from frontmatter.
 *   - `archived` and `orphaned` are boolean **frontmatter** flags.
 *   - `scanWikiPages` returns `{ slug, meta }` only (no body), so `listPages`
 *     always re-reads each file to extract body links even when `includeBody`
 *     is false.
 *   - Path safety is enforced at `getPage` entry via `assertSafeSlug`; symlink
 *     confinement is handled at a lower level by `scanWikiPages`.
 *   - `getPageFrom` and `listPagesFrom` are THE BODIES and hold no project
 *     root: they reach the project only through {@link PageReads}, five reads
 *     this module names itself. `getPage(root, …)` and `listPages(root, …)` are
 *     delegates over a private binding built per call, whose members call the
 *     same readers with the same paths as before. Naming the reads selects no
 *     backend and rules on no mechanism; every member of the local binding is
 *     still local disk.
 */

import path from "path";
import { scanWikiPages } from "../compiler/indexgen.js";
import type { ScannedPage } from "../compiler/indexgen.js";
import { safeReadFile, parseFrontmatter } from "../utils/markdown.js";
import { extractWikilinkSlugs } from "../wiki/collect.js";
import { assertSafeSlug } from "../viewer/path-safety.js";
import { CONCEPTS_DIR, QUERIES_DIR, TIMELINE_DIR } from "../utils/constants.js";
import { loadNonDefaultProfile, collectEntityPagesWithMessages } from "../profile/block.js";
import { journalHealthWarning } from "../trust/journal-health-warning.js";
import type { JournalWarning } from "../trust/journal-health-warning.js";
import { toEntityPageView } from "../profile/types.js";
import type { EntityPageView, EntityProblemView, EntityPage, LoadedProfile } from "../profile/types.js";
import type { PageDirectory } from "../export/types.js";

export type { PageDirectory };

/** A reference to a specific page by its directory and slug. */
export interface PageRef {
  pageDirectory: PageDirectory;
  slug: string;
}

/** A fully-resolved in-memory representation of a single wiki page. */
export interface Page {
  slug: string;
  pageDirectory: PageDirectory;
  title: string;
  summary: string;
  tags: string[];
  /** Slugs of pages linked via `[[wikilinks]]` in the body. */
  links: string[];
  createdAt?: string;
  updatedAt?: string;
  /** True when frontmatter contains `orphaned: true`. */
  orphaned: boolean;
  /** True when frontmatter contains `archived: true`. */
  archived: boolean;
  /** Full markdown body, present only when `includeBody` is true or via `getPage`. */
  body?: string;
}

/** Options for filtering and paginating `listPages`. */
export interface ListPagesOptions {
  cursor?: string;
  limit?: number;
  includeBody?: boolean;
  includeArchived?: boolean;
  includeOrphaned?: boolean;
  /**
   * Opaque continuation cursor for the ADDITIVE profile entity section ONLY.
   * Drives the entity window independently of the legacy `cursor` (which scopes
   * `pages`), so the entity batch is never re-sliced or re-sent by legacy
   * paging. Uses the SAME `limit` as the legacy section.
   */
  profileCursor?: string;
  /**
   * Opaque continuation cursor for the ADDITIVE profile `problems` section ONLY.
   * Windows collector problems independently of `cursor`/`profileCursor`, using
   * the SAME `limit`, so a partially-invalid profile never returns thousands of
   * problems per page. Drive the next batch via {@link ListPagesProfileBlock.problemCursor}.
   */
  problemCursor?: string;
}

/**
 * Additive, non-default-profile entity-page block for `listPages`.
 *
 * Present ONLY for a non-default profile; for the built-in default it is
 * ABSENT (`result.profile === undefined`) so the default envelope is unchanged.
 * `entityPages` carries the PUBLIC `EntityPageView`s (project-relative `path`,
 * never an absolute `filePath`); each view's `body` is OMITTED when
 * `includeBody` is false (mirroring how the legacy `pages` block omits bodies).
 *
 * The entity section is BOUNDED by `limit`: it returns at most `limit` views,
 * deterministically sorted by `id`, with `total` reporting the full entity-page
 * count and `cursor` carrying the offset of the NEXT batch (absent when
 * exhausted). Drive the next batch via {@link ListPagesOptions.profileCursor},
 * which is independent of the legacy `pages` cursor.
 *
 * @experimental Shape may change in a future release.
 */
export interface ListPagesProfileBlock {
  entityPages: EntityPageView[];
  /** Full count of entity pages across the whole non-default profile. */
  total: number;
  /**
   * Opaque continuation cursor for the NEXT entity batch; absent when the
   * entity section is exhausted. Pass back via `profileCursor`.
   */
  cursor?: string;
  /**
   * Structured collector problems, WINDOWED by `limit` independently of
   * `entityPages` (its own `problemCursor` offset). Present ONLY when the window
   * is non-empty; each `path` is project-relative (never absolute) and absent
   * for directory-level problems. See `problemTotal` for the full count.
   */
  problems?: EntityProblemView[];
  /** Full count of collector problems across the profile; present ONLY when non-empty. */
  problemTotal?: number;
  /**
   * Opaque continuation cursor for the NEXT `problems` batch; absent when the
   * problem section is exhausted. Pass back via `problemCursor`.
   */
  problemCursor?: string;
}

/**
 * Result returned by `listPages`.
 *
 * DX note: for a NON-DEFAULT profile the legacy `pages` array is scoped to
 * concepts/queries (typically EMPTY for an entity-only project); the entity
 * content lives in `profile.entityPages`. Read the entity section there, not
 * from `pages`.
 */
export interface ListPagesResult {
  pages: Page[];
  /** Opaque cursor for the next page; absent when the listing is exhausted. */
  cursor?: string;
  /**
   * Non-default profile entity pages, ADDITIVELY. ABSENT (undefined) for the
   * built-in default so the default envelope is byte-identical; the legacy
   * `pages` block stays scoped to concepts/queries in both cases. For a
   * non-default profile this is where the entity content lives — the legacy
   * `pages` array is typically empty.
   */
  profile?: ListPagesProfileBlock;
  /**
   * Read-surface health warnings. ABSENT (key omitted) for a healthy project so
   * the default envelope is byte-identical (parity-safe); present ONLY when the
   * compile journal is `pending` (`incomplete-compile`) or `unavailable`
   * (`journal-unavailable`), so an agent listing pages never treats partial
   * post-crash or tampered content as a complete, clean listing.
   */
  warnings?: ListPagesWarning[];
}

/** One read-surface health warning carried on a {@link ListPagesResult}. */
export interface ListPagesWarning {
  code: string;
  message: string;
}

/** Maps each PageDirectory to its project-relative path. */
const DIR_NAMES: Record<PageDirectory, string> = {
  concepts: CONCEPTS_DIR,
  queries: QUERIES_DIR,
  timeline: TIMELINE_DIR,
};

/** All page directories in listing order. */
const PAGE_DIRECTORIES: PageDirectory[] = ["concepts", "queries", "timeline"];

/**
 * Every read the two page functions make. `getPageFrom` asks only
 * `readPageText`, once. `listPagesFrom` asks, one after another: for concepts
 * and then for queries, `scanPages` once and then `readPageText` once per
 * scanned page; then `loadProfile`; then `collectEntityPages` only for a
 * non-default profile; then `journalWarning`.
 */
export interface PageReads {
  /**
   * One page's whole text. THE EMPTY STRING FOR EVERY FAILURE: an absent file,
   * a directory, a link that cannot be followed and a failed read are all `""`
   * and are not told apart. Never rejects. On local disk the read follows links
   * and is NOT confined to the page directory; that is the incumbent behaviour,
   * kept as it is.
   */
  readPageText(dir: PageDirectory, slug: string): Promise<string>;
  /** Every `.md` page of one directory with its parsed frontmatter and no body; empty when the directory cannot be listed. */
  scanPages(dir: PageDirectory): Promise<ScannedPage[]>;
  /** The active non-default profile; `undefined` for the built-in default. */
  loadProfile(): Promise<LoadedProfile | undefined>;
  /** The promoted entity pages of a non-default profile, with their collector problems as views. */
  collectEntityPages(loaded: LoadedProfile): Promise<{ pages: EntityPage[]; problems: EntityProblemView[] }>;
  /** The journal health warning, or `null` for a healthy journal. */
  journalWarning(): Promise<JournalWarning | null>;
}

/**
 * LOCAL DISK. The page reads for the project at `root`, built per call and
 * private to this module. Building them does no I/O and evaluates nothing:
 * each member calls its reader, with the path it always had, only when asked.
 */
function diskPageReads(root: string): PageReads {
  return {
    readPageText: (dir, slug) => safeReadFile(path.join(root, DIR_NAMES[dir], `${slug}.md`)),
    scanPages: (dir) => scanWikiPages(path.join(root, DIR_NAMES[dir])),
    loadProfile: () => loadNonDefaultProfile(root),
    collectEntityPages: (loaded) => collectEntityPagesWithMessages(root, loaded),
    journalWarning: () => journalHealthWarning(root),
  };
}

/**
 * Build a Page from its directory, slug, parsed frontmatter, and body text.
 * Links are always extracted from the body so they reflect real wikilinks,
 * not any frontmatter list.
 */
function buildPage(
  dir: PageDirectory,
  slug: string,
  meta: Record<string, unknown>,
  body: string,
  includeBody: boolean,
): Page {
  return {
    slug,
    pageDirectory: dir,
    title: typeof meta.title === "string" ? meta.title : slug,
    summary: typeof meta.summary === "string" ? meta.summary : "",
    tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
    links: extractWikilinkSlugs(body),
    createdAt: typeof meta.createdAt === "string" ? meta.createdAt : undefined,
    updatedAt: typeof meta.updatedAt === "string" ? meta.updatedAt : undefined,
    orphaned: meta.orphaned === true,
    archived: meta.archived === true,
    ...(includeBody ? { body } : {}),
  };
}

/**
 * Fetch a single page by directory and slug.
 *
 * Throws `PathSafetyError` for unsafe slug values. Returns `null` when the
 * page does not exist on disk.
 *
 * @param root - Absolute path to the wiki workspace root.
 * @param ref - Which directory and slug to load.
 */
export async function getPage(root: string, ref: PageRef): Promise<Page | null> {
  return getPageFrom(diskPageReads(root), ref);
}

/** {@link getPage} through `reads`: THE ONE BODY. The slug is checked BEFORE any read; an empty text is "no page". */
export async function getPageFrom(reads: PageReads, ref: PageRef): Promise<Page | null> {
  assertSafeSlug(ref.slug);
  const content = await reads.readPageText(ref.pageDirectory, ref.slug);
  if (!content) return null;
  const { meta, body } = parseFrontmatter(content);
  return buildPage(ref.pageDirectory, ref.slug, meta, body, true);
}

/**
 * List pages from both wiki directories with optional filtering and cursor
 * pagination.
 *
 * Pages are sorted by `(pageDirectory, slug)` before slicing. Bodies are
 * omitted by default; pass `includeBody: true` to include them. Orphaned
 * and archived pages are excluded by default; pass the corresponding flag
 * to include them.
 *
 * @param root - Absolute path to the wiki workspace root.
 * @param options - Filtering, pagination, and inclusion options.
 */
export async function listPages(
  root: string,
  options: ListPagesOptions = {},
): Promise<ListPagesResult> {
  return listPagesFrom(diskPageReads(root), options);
}

/** {@link listPages} through `reads`: THE ONE BODY. See {@link PageReads} for the order of the reads. */
export async function listPagesFrom(reads: PageReads, options: ListPagesOptions = {}): Promise<ListPagesResult> {
  const all = await collectPages(reads, options);
  all.sort(
    (a, b) =>
      a.pageDirectory.localeCompare(b.pageDirectory) || a.slug.localeCompare(b.slug),
  );
  const result = paginate(all, options);
  const profile = await collectProfileBlock(reads, options);
  const withProfile = profile ? { ...result, profile } : result;
  // Surface a pending/unavailable compile journal so an agent listing pages
  // never treats partial post-crash state as a complete listing. ABSENT when the
  // journal is ok, so the default envelope is byte-identical (parity-safe).
  const warning = await reads.journalWarning();
  return warning ? { ...withProfile, warnings: [warning] } : withProfile;
}

/**
 * Resolve a window offset from an opaque cursor for an additive profile section.
 * A non-integer or negative cursor is rejected rather than silently recycled
 * (mirroring the legacy {@link paginate} cursor guard). `name` identifies the
 * offending cursor option in the error so callers can tell which one was bad.
 */
function profileOffset(cursor: string | undefined, name: string): number {
  const offset = cursor !== undefined ? Number(cursor) : 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`invalid listPages ${name}: ${cursor}`);
  }
  return offset;
}

/**
 * For a NON-DEFAULT profile only, build the additive `profile` block from the
 * content-carrying entity collector. Returns `undefined` for the built-in
 * default so the legacy envelope is unchanged — gated through the shared
 * {@link loadNonDefaultProfile} primitive, exactly as `status` does.
 *
 * Honors `includeBody`: each view's `body` is OMITTED (key absent) when bodies
 * are not requested, mirroring how the legacy `pages` block omits bodies. Maps
 * the internal `EntityPage` to the public `EntityPageView` so the absolute
 * `filePath` never reaches the surface.
 *
 * BOUNDED + PAGINATED: entity pages are deterministically sorted by `id` (entity
 * collection order is filesystem-dependent and unstable), then windowed by the
 * SAME `limit` as the legacy section, offset by `profileCursor`. `total` reports
 * the full count and `cursor` carries the next offset (absent when exhausted) —
 * so a large profile no longer returns an unbounded, body-bearing payload.
 */
async function collectProfileBlock(
  reads: PageReads,
  options: ListPagesOptions,
): Promise<ListPagesProfileBlock | undefined> {
  const loaded = await reads.loadProfile();
  if (loaded === undefined) return undefined;
  const { pages, problems } = await reads.collectEntityPages(loaded);
  pages.sort((a, b) => a.id.localeCompare(b.id));
  const includeBody = options.includeBody === true;
  return windowEntityPages(pages, options, includeBody, problems);
}

/** An offset window over a list: the slice plus the next-batch offset (absent when exhausted). */
interface OffsetWindow<T> {
  items: T[];
  cursor?: string;
}

/**
 * Slice an already-ordered list into a bounded window at `offset`, sized by the
 * SAME `limit` contract as the legacy {@link paginate} (non-positive/absent limit
 * = unbounded). The returned `cursor` is the offset past the window, absent once
 * the list is exhausted. Shared by the entity-page and problem windows so the two
 * never drift.
 */
function sliceWindow<T>(items: T[], offset: number, limit: number | undefined): OffsetWindow<T> {
  const effectiveLimit = limit && limit > 0 ? limit : items.length;
  const window = items.slice(offset, offset + effectiveLimit);
  const nextOffset = offset + window.length;
  return { items: window, ...(nextOffset < items.length ? { cursor: String(nextOffset) } : {}) };
}

/**
 * Slice an already-sorted entity-page list into a bounded, cursor-paged block,
 * windowing `problems` by the SAME `limit` under an INDEPENDENT `problemCursor`
 * offset (with `problemTotal`/`problemCursor`) so a partially-invalid profile
 * never returns thousands of problems per page. Entity `cursor` and problem
 * `problemCursor` advance separately; the next-batch cursors are absent once
 * each section is exhausted.
 */
function windowEntityPages(
  pages: EntityPage[],
  options: ListPagesOptions,
  includeBody: boolean,
  problems: EntityProblemView[],
): ListPagesProfileBlock {
  const pageWindow = sliceWindow(pages, profileOffset(options.profileCursor, "profileCursor"), options.limit);
  const problemWindow = sliceWindow(problems, profileOffset(options.problemCursor, "problemCursor"), options.limit);
  return {
    entityPages: pageWindow.items.map((page) => toEntityPageView(page, includeBody)),
    total: pages.length,
    ...(pageWindow.cursor !== undefined ? { cursor: pageWindow.cursor } : {}),
    ...(problems.length > 0 ? { problems: problemWindow.items, problemTotal: problems.length } : {}),
    ...(problemWindow.cursor !== undefined ? { problemCursor: problemWindow.cursor } : {}),
  };
}

/**
 * Read every page from both directories, applying the archive/orphan filters.
 * Bodies are always read so wikilinks can be extracted; they are only retained
 * on the returned Page when `includeBody` is set.
 */
async function collectPages(reads: PageReads, options: ListPagesOptions): Promise<Page[]> {
  const all: Page[] = [];
  for (const dir of PAGE_DIRECTORIES) {
    for (const { slug, meta } of await reads.scanPages(dir)) {
      const content = await reads.readPageText(dir, slug);
      const { body } = parseFrontmatter(content);
      const page = buildPage(dir, slug, meta, body, options.includeBody === true);
      if (page.orphaned && !options.includeOrphaned) continue;
      if (page.archived && !options.includeArchived) continue;
      all.push(page);
    }
  }
  return all;
}

/**
 * Slice an already-sorted page list into a cursor-paged result. A non-positive
 * or absent limit is treated as unbounded (avoids a `limit: 0` empty-slice loop);
 * a non-integer or negative cursor is rejected rather than silently recycled.
 */
function paginate(all: Page[], options: ListPagesOptions): ListPagesResult {
  const offset = options.cursor !== undefined ? Number(options.cursor) : 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`invalid listPages cursor: ${options.cursor}`);
  }
  const limit = options.limit && options.limit > 0 ? options.limit : all.length;
  const slice = all.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  const cursor = nextOffset < all.length ? String(nextOffset) : undefined;
  return cursor !== undefined ? { pages: slice, cursor } : { pages: slice };
}
