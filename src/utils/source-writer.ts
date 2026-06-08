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
 */

import { mkdir, readdir, readFile, writeFile, lstat } from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { parseFrontmatter, slugify } from "./markdown.js";
import { safeRealpath, confinedRegularFile } from "./path-confine.js";
import { SOURCES_DIR } from "./constants.js";
import { PathSafetyError } from "../viewer/path-safety.js";
import type { WriteStatus } from "./types.js";

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
  sourcesDir: string,
  slug: string,
  source: string,
): Promise<string> {
  const candidate = `${slug}.md`;
  const candidatePath = path.join(sourcesDir, candidate);
  try {
    // No-follow existence probe: lstat never reads or follows a planted symlink
    // at sources/<slug>.md (readFile here would EISDIR on a symlinked dir or leak
    // an outside file). The actual write is still guarded by wx/lstat downstream.
    await lstat(candidatePath);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return candidate;
    throw err;
  }
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
async function findFileBySourceIdentity(sourcesDir: string, source: string): Promise<string | null> {
  let names: string[];
  try {
    names = (await readdir(sourcesDir)).filter((f) => f.endsWith(".md")).sort();
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
  for (const name of names) {
    // Regular files only: symlinks (whether escaping or in-tree aliases) are never
    // sources, keeping the scan consistent with list/get/delete.
    const real = await confinedRegularFile(sourcesDir, name);
    if (real === null) continue;
    const { meta } = parseFrontmatter(await readFile(real, "utf-8"));
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
  // Create <root>/sources first — recursive mkdir creates a missing root + sources as
  // real dirs (the SDK contract: a fresh, not-yet-existing root is accepted on first
  // ingest). mkdir never follows a trailing symlink, so it won't write through a
  // symlinked sources/.
  await mkdir(path.join(root, SOURCES_DIR), { recursive: true });
  // Canonicalize root and re-derive the TRUSTED sources path; reject a symlinked-away sources/.
  const canonicalRoot = await safeRealpath(root);
  if (canonicalRoot === null) throw new PathSafetyError(`root does not exist: ${root}`); // defensive; mkdir created it
  const sourcesDir = path.join(canonicalRoot, SOURCES_DIR);
  if (!(await lstat(sourcesDir)).isDirectory()) {
    throw new PathSafetyError(`sources/ must be a real directory, not a symlink`);
  }

  // The source identity (not the title-derived slug) is the key: reuse the
  // existing file for this source even if the title changed; only allocate a
  // new (slug-based) filename when this is a genuinely new source.
  const existingByIdentity = await findFileBySourceIdentity(sourcesDir, source);
  const filename = existingByIdentity ?? (await resolveCollisionFreeFilename(sourcesDir, slug, source));
  const destPath = path.join(sourcesDir, filename);

  if (existingByIdentity === null) {
    // New source: exclusive create — never write through a pre-existing entry
    // (e.g. a planted symlink at the slug/hash destination).
    try {
      await writeFile(destPath, document, { encoding: "utf-8", flag: "wx" });
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
  if (!(await lstat(destPath)).isFile()) {
    throw new PathSafetyError(`refusing to write: ${filename} is not a regular file`);
  }
  const existing = await readFile(destPath, "utf-8");
  if (stableContent(existing) === stableContent(document)) {
    return { path: destPath, writeStatus: "unchanged" };
  }
  await writeFile(destPath, document, "utf-8");
  return { path: destPath, writeStatus: "updated" };
}
