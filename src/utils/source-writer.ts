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

import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { parseFrontmatter, slugify } from "./markdown.js";
import { SOURCES_DIR } from "./constants.js";

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
 * Resolve the destination filename for a slug + source identity:
 *
 * - When `${slug}.md` does not exist, return `${slug}.md`.
 * - When it exists and its frontmatter `source` matches the incoming
 *   source, return `${slug}.md` so re-ingest stays idempotent.
 * - Otherwise return `${slug}-<hash>.md` so two distinct sources that
 *   share a basename coexist instead of one silently overwriting the
 *   other.
 */
async function resolveCollisionFreeFilename(
  sourcesDir: string,
  slug: string,
  source: string,
): Promise<string> {
  const candidate = `${slug}.md`;
  const candidatePath = path.join(sourcesDir, candidate);
  let existing: string;
  try {
    existing = await readFile(candidatePath, "utf-8");
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "ENOENT") return candidate;
    throw err;
  }
  const { meta } = parseFrontmatter(existing);
  if (typeof meta.source === "string" && meta.source === source) {
    return candidate;
  }
  return `${slug}-${shortHashOfSource(source)}.md`;
}

/**
 * Write a markdown document into `sources/` under a slug derived from
 * the title, applying the empty-slug guard and basename-collision
 * disambiguation. Returns the resolved destination path.
 *
 * @param title - Human-readable title used to derive the filename.
 * @param document - Full markdown content (frontmatter + body) to write.
 * @param source - Source identity (URL, file path, etc.) used both for
 *                 collision disambiguation and idempotency on re-ingest.
 */
export async function saveSource(
  root: string,
  title: string,
  document: string,
  source: string,
): Promise<string> {
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
  const sourcesDir = path.join(root, SOURCES_DIR);
  await mkdir(sourcesDir, { recursive: true });
  const filename = await resolveCollisionFreeFilename(sourcesDir, slug, source);
  const destPath = path.join(sourcesDir, filename);
  await writeFile(destPath, document, "utf-8");
  return destPath;
}
