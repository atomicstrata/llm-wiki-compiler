/**
 * Shared writer for the `sources/` directory.
 *
 * Centralises the slug → filename resolution every ingest path needs, so
 * `ingest`, `ingest-session`, and any future ingester get the same
 * protections:
 *
 *  - Empty-slug guard (#35): titles that strip to "" (e.g. pure emoji)
 *    fail with an actionable error instead of writing `sources/.md`.
 *  - Stable basename-collision suffix (#36): two distinct sources that
 *    slugify to the same name coexist as `name.md` and
 *    `name-<8-hex-of-source>.md`; re-ingesting the same source still
 *    overwrites in place because the existing file's frontmatter
 *    `source` field is consulted before suffixing.
 *
 * ONE BODY: {@link saveSourceWith} keeps the slug guard, the identity scan, the
 * collision name, new-versus-update, the exclusive create and its EEXIST
 * refusal, the regular-file check and the stable-content comparison over
 * {@link SourceWriterLeaves}. {@link saveSource} keeps its signature and passes
 * {@link diskSourceWriterLeaves}, whose `openSourcesDir` keeps the incumbent
 * mkdir, canonical-root and real-directory checks and whose members call the
 * incumbent leaf helpers when asked. The returned `path` is the handle joined
 * with the file name, exactly as before.
 *
 * Which names count as existing identities is its own one body,
 * {@link listIdentityNamesFrom}, over {@link SourceIdentityReads}: the project's
 * source selection with its compile exclusions dropped.
 */

import path from "path";
import { createHash } from "crypto";
import { parseFrontmatter, slugify } from "./markdown.js";
import { safeRealpath, confinedRegularFile } from "./path-confine.js";
import { SOURCES_DIR } from "./constants.js";
import { PathSafetyError } from "../viewer/path-safety.js";
import type { WriteStatus } from "./types.js";
import { listSelectedSourceFiles, listSelectedSourceFilesFrom } from "../sources/scan.js";
import { loadSourceSelection, loadSourceSelectionFrom, type SourceSelection } from "../sources/selection.js";
import type { LegacyLocalReads } from "../storage/legacy-local-reads.js";
import { leafPresent, makeDirectoryTree } from "../storage/disk-guarded-leaves.js";
import { locationKindNoFollow } from "../storage/disk-local-reads.js";
import { createLocationTextExclusive, overwriteLocationText, readLocationText } from "../storage/disk-locations.js";

/** Length of the hex hash suffix appended to disambiguate basename collisions. */
const COLLISION_HASH_LEN = 8;

/**
 * Compute a short, stable hex hash of a source identifier. Stability
 * matters — re-ingesting the same source must always produce the same
 * hash so existing files are overwritten cleanly rather than
 * accumulating duplicates.
 */
function shortHashOfSource(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, COLLISION_HASH_LEN);
}

/** What `saveSource` asks of the store. `dir` is the handle {@link SourceWriterLeaves.openSourcesDir} returned. */
export interface SourceWriterLeaves {
  /** Create (if needed) and confine `sources/`; its handle. Rejects when it is not a real directory. */
  openSourcesDir(): Promise<string>;
  /** Every source name the identity scan considers (compile exclusions ignored). */
  listIdentityNames(dir: string): Promise<string[]>;
  /** The confined regular file behind `name`, or null for a missing entry, a symlink or a directory. */
  regularFile(dir: string, name: string): Promise<string | null>;
  /** One file's text. */
  readText(file: string): Promise<string>;
  /** Whether ANY entry occupies `name` (no-follow); only absence is false. */
  entryPresent(dir: string, name: string): Promise<boolean>;
  /** Create `name` exclusively; rejects `EEXIST` when anything is already there. */
  createExclusive(dir: string, name: string, text: string): Promise<void>;
  /** The no-follow kind of the entry at `name`. */
  entryKind(dir: string, name: string): Promise<string>;
  /** Replace the existing regular file `name`. */
  overwrite(dir: string, name: string, text: string): Promise<void>;
  /**
   * OPTIONAL bounded identity lookup (the `local-indexed` catalog): the name of
   * the source holding `source`, verified by reading that file alone, or null.
   * Absent: the incumbent scan of every source name runs.
   */
  lookupIdentity?(dir: string, source: string): Promise<string | null>;
}

/** The identity scan's two reads. Neither takes a project root. */
export interface SourceIdentityReads {
  /** The project's source selection (recursion and compile exclusions). */
  loadSelection(): Promise<SourceSelection>;
  /** The source names `selection` selects. */
  listSelected(selection: SourceSelection): Promise<string[]>;
}

/**
 * Every source name an explicit ingest must treat as an existing identity: THE
 * ONE BODY. The project's selection is loaded first and listed with its compile
 * exclusions DROPPED (recursion kept), because an explicit re-ingest updates an
 * existing identity even when compile excludes it; otherwise selecting an inbox
 * later would reveal two copies of the same source.
 */
export async function listIdentityNamesFrom(reads: SourceIdentityReads): Promise<string[]> {
  const selection = await reads.loadSelection();
  return reads.listSelected({ ...selection, exclude: [] });
}

/** The identity reads over the selection and scan bodies' own seam. Building them does no I/O. */
export function sourceIdentityReadsOver(reads: LegacyLocalReads): SourceIdentityReads {
  return {
    loadSelection: () => loadSourceSelectionFrom(reads),
    listSelected: (selection) => listSelectedSourceFilesFrom(reads, selection),
  };
}

/** LOCAL DISK: the incumbent confinement and leaf helpers for one root, built per call, each called when asked. In no package index. */
export function diskSourceWriterLeaves(root: string): SourceWriterLeaves {
  const at = (dir: string, name: string) => path.join(dir, name);
  return {
    openSourcesDir: () => openConfinedSourcesDir(root),
    listIdentityNames: async (dir) => {
      // The CANONICAL root: the parent of the confined sources handle, not the caller's root.
      const scanRoot = path.dirname(dir);
      return listIdentityNamesFrom({
        loadSelection: () => loadSourceSelection(scanRoot),
        listSelected: (selection) => listSelectedSourceFiles(scanRoot, selection),
      });
    },
    regularFile: (dir, name) => confinedRegularFile(dir, name),
    readText: (file) => readLocationText(file),
    entryPresent: (dir, name) => leafPresent(dir, name),
    createExclusive: (dir, name, text) => createLocationTextExclusive(at(dir, name), text),
    entryKind: (dir, name) => locationKindNoFollow(at(dir, name)),
    overwrite: (dir, name, text) => overwriteLocationText(at(dir, name), text),
  };
}

/**
 * Create `<root>/sources` and return its TRUSTED canonical path, rejecting a
 * symlinked-away `sources/`: the incumbent physical confinement, unchanged.
 */
async function openConfinedSourcesDir(root: string): Promise<string> {
  // Create <root>/sources first — recursive mkdir creates a missing root + sources as
  // real dirs (the SDK contract: a fresh, not-yet-existing root is accepted on first
  // ingest). mkdir never follows a trailing symlink, so it won't write through a
  // symlinked sources/.
  await makeDirectoryTree(path.join(root, SOURCES_DIR));
  // Canonicalize root and re-derive the TRUSTED sources path; reject a symlinked-away sources/.
  const canonicalRoot = await safeRealpath(root);
  if (canonicalRoot === null) throw new PathSafetyError(`root does not exist: ${root}`); // defensive; mkdir created it
  const sourcesDir = path.join(canonicalRoot, SOURCES_DIR);
  if ((await locationKindNoFollow(sourcesDir)) !== "directory") {
    throw new PathSafetyError(`sources/ must be a real directory, not a symlink`);
  }
  return sourcesDir;
}

/**
 * Resolve the destination filename for a slug + source identity when no
 * existing file owns this source (source-identity matching is handled upstream
 * by `findFileBySourceIdentity` before this is called):
 *
 * - When `${slug}.md` does not exist, return `${slug}.md`.
 * - When it exists (necessarily owned by a DIFFERENT source), return
 *   `${slug}-<hash>.md` so two distinct sources that share a basename
 *   coexist instead of one silently overwriting the other.
 */
async function resolveCollisionFreeFilename(
  leaves: SourceWriterLeaves,
  sourcesDir: string,
  slug: string,
  source: string,
): Promise<string> {
  const candidate = `${slug}.md`;
  // No-follow existence probe: one lstat of sources/<slug>.md, which never reads
  // or follows a planted symlink there (readFile here would EISDIR on a symlinked
  // dir or leak an outside file). Only ENOENT means the name is free; any other
  // failure rejects with the raw error. The actual write is still guarded by
  // wx/lstat downstream.
  if (!(await leaves.entryPresent(sourcesDir, candidate))) return candidate;
  // An entry already occupies sources/<slug>.md (a different source, or a planted
  // symlink) — append a stable hash suffix instead of touching it.
  return `${slug}-${shortHashOfSource(source)}.md`;
}

/**
 * Find the existing source file whose frontmatter `source` matches `source`,
 * regardless of its title-derived filename — the source identity is the key,
 * so re-ingesting under a renamed title updates the same file instead of
 * forking. O(number of sources) per ingest — reads each existing source, so
 * bulk ingest is O(n^2); a `source`->filename manifest index is the planned
 * v1.x remedy for large source sets.
 *
 * Regular files only (via `confinedRegularFile`): any symlink entry — whether
 * escaping `sourcesDir` or an in-tree alias — is skipped, keeping the scan
 * consistent with list/get/delete and preventing arbitrary-file-reads and
 * confused-deputy write-through via `saveSource`.
 */
async function findFileBySourceIdentity(
  leaves: SourceWriterLeaves, sourcesDir: string, source: string,
): Promise<string | null> {
  if (leaves.lookupIdentity !== undefined) return leaves.lookupIdentity(sourcesDir, source);
  const names = await leaves.listIdentityNames(sourcesDir);
  for (const name of names) {
    // Regular files only: symlinks (whether escaping or in-tree aliases) are never
    // sources, keeping the scan consistent with list/get/delete.
    const real = await leaves.regularFile(sourcesDir, name);
    if (real === null) continue;
    const { meta } = parseFrontmatter(await leaves.readText(real));
    if (typeof meta.source === "string" && meta.source === source) return name;
  }
  return null;
}

/**
 * Canonical comparison key for a source document: stable frontmatter + body,
 * excluding volatile fields (`ingestedAt`). So a re-ingest with identical
 * content but a fresh timestamp is `unchanged`, while a changed title /
 * sourceType / truncation is `updated`.
 */
function stableContent(document: string): string {
  const { meta, body } = parseFrontmatter(document);
  const stable: Record<string, unknown> = {};
  for (const key of Object.keys(meta).sort()) {
    if (key === "ingestedAt") continue;
    stable[key] = meta[key];
  }
  return `${JSON.stringify(stable)}\n${body}`;
}

/**
 * Write a markdown document into `sources/` under a slug derived from
 * the title, applying the empty-slug guard and basename-collision
 * disambiguation.
 *
 * The source identity (not the title-derived slug) is the key: if the same
 * source was previously saved under a different title, the existing file is
 * updated in place rather than forking a new file. Stable frontmatter fields
 * (title, sourceType, truncated, originalChars) are included in the
 * comparison so changed metadata is detected, but volatile fields (`ingestedAt`)
 * are excluded so a re-ingest with fresh timestamp is still `"unchanged"`.
 *
 * @param title - Human-readable title used to derive the filename for new sources.
 * @param document - Full markdown content (frontmatter + body) to write.
 * @param source - Source identity (URL, file path, etc.) used as the canonical
 *                 key for finding existing files and collision disambiguation.
 * @returns An object with the resolved destination `path` and a
 *          `writeStatus` of `"created"`, `"updated"`, or `"unchanged"`.
 */
export async function saveSource(
  root: string,
  title: string,
  document: string,
  source: string,
): Promise<{ path: string; writeStatus: WriteStatus }> {
  return saveSourceWith(diskSourceWriterLeaves(root), title, document, source);
}

/** {@link saveSource} over {@link SourceWriterLeaves}: THE ONE BODY. */
export async function saveSourceWith(
  leaves: SourceWriterLeaves,
  title: string,
  document: string,
  source: string,
): Promise<{ path: string; writeStatus: WriteStatus }> {
  const slug = slugify(title);
  // Defense in depth — even with the Unicode-aware slugifier (#35), a
  // title made entirely of punctuation/emoji/symbols still slugifies to
  // "". Without this guard the file would land at sources/.md.
  if (!slug) {
    throw new Error(
      `Could not derive a filename from title "${title}". ` +
        `The title contains no letter or number characters. ` +
        `Rename the source file to one with at least one letter or digit.`,
    );
  }
  const sourcesDir = await leaves.openSourcesDir();

  // The source identity (not the title-derived slug) is the key: reuse the
  // existing file for this source even if the title changed; only allocate a
  // new (slug-based) filename when this is a genuinely new source.
  const existingByIdentity = await findFileBySourceIdentity(leaves, sourcesDir, source);
  const filename = existingByIdentity ?? (await resolveCollisionFreeFilename(leaves, sourcesDir, slug, source));
  const destPath = path.join(sourcesDir, filename);

  if (existingByIdentity === null) {
    // New source: exclusive create — never write through a pre-existing entry
    // (e.g. a planted symlink at the slug/hash destination).
    try {
      await leaves.createExclusive(sourcesDir, filename, document);
    } catch (err) {
      if ((err as { code?: string }).code === "EEXIST") {
        throw new PathSafetyError(`refusing to write: ${filename} already exists in sources/`);
      }
      throw err;
    }
    return { path: destPath, writeStatus: "created" };
  }
  // Update: the identity scan returned an in-tree match — require a regular file
  // (reject an intra-sources symlink target; never writeFile through a symlink).
  if ((await leaves.entryKind(sourcesDir, filename)) !== "file") {
    throw new PathSafetyError(`refusing to write: ${filename} is not a regular file`);
  }
  const existing = await leaves.readText(destPath);
  if (stableContent(existing) === stableContent(document)) {
    return { path: destPath, writeStatus: "unchanged" };
  }
  await leaves.overwrite(sourcesDir, filename, document);
  return { path: destPath, writeStatus: "updated" };
}
