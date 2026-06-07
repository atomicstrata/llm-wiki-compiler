/**
 * Source-store API for the llmwiki SDK: list / get sources under `sources/`.
 * Source IDs are bare basenames including `.md` (e.g. "note.md") — opaque,
 * path-safe, never joined with an extra extension. Read-only, no LLM.
 */
import path from "path";
import { readdir, readFile, unlink } from "fs/promises";
import { parseFrontmatter } from "../utils/markdown.js";
import { PathSafetyError } from "../viewer/path-safety.js";
import { SOURCES_DIR } from "../utils/constants.js";

/** A single source file under `sources/`, with frontmatter metadata. */
export interface SourceRecord {
  id: string;          // basename incl. ".md"
  title: string;
  source: string;      // frontmatter `source` identity
  sourceType: string;
  ingestedAt?: string;
  body?: string;
}

/** Options for paginating `listSources` and opting into source bodies. */
export interface ListSourcesOptions { cursor?: string; limit?: number; includeBody?: boolean }

/** Result returned by `listSources`. */
export interface ListSourcesResult { sources: SourceRecord[]; cursor?: string }

/** Reject anything that isn't a bare `sources/` basename ending in `.md`. */
function assertSafeSourceId(id: string): void {
  if (typeof id !== "string" || id.length === 0) throw new PathSafetyError("source id must be a non-empty string");
  if (!id.endsWith(".md")) throw new PathSafetyError(`source id must end in .md: "${id}"`);
  // Conservative: real source IDs are `slug-<hex>.md` (slugified title + collision
  // hash) and never contain `..`, so rejecting any `..` substring is safe and
  // simpler than component-level normalization.
  if (id.includes("/") || id.includes("\\") || id.includes("\0") || id.includes(".."))
    throw new PathSafetyError(`source id must be a bare basename: "${id}"`);
}

function toRecord(id: string, content: string, includeBody: boolean): SourceRecord {
  const { meta, body } = parseFrontmatter(content);
  return {
    id,
    title: typeof meta.title === "string" ? meta.title : id,
    source: typeof meta.source === "string" ? meta.source : "",
    sourceType: typeof meta.sourceType === "string" ? meta.sourceType : "file",
    ingestedAt: typeof meta.ingestedAt === "string" ? meta.ingestedAt : undefined,
    ...(includeBody ? { body } : {}),
  };
}

export async function listSources(root: string, options: ListSourcesOptions = {}): Promise<ListSourcesResult> {
  const dir = path.join(root, SOURCES_DIR);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return { sources: [] };
    throw err;
  }
  const offset = options.cursor !== undefined ? Number(options.cursor) : 0;
  if (!Number.isInteger(offset) || offset < 0) throw new Error(`invalid listSources cursor: ${options.cursor}`);
  const limit = options.limit && options.limit > 0 ? options.limit : files.length;
  const page = files.slice(offset, offset + limit);
  const sources: SourceRecord[] = [];
  for (const id of page) {
    const content = await readFile(path.join(dir, id), "utf-8");
    sources.push(toRecord(id, content, options.includeBody === true));
  }
  const next = offset + page.length < files.length ? String(offset + page.length) : undefined;
  return next !== undefined ? { sources, cursor: next } : { sources };
}

/**
 * Delete the source file `sources/<id>` (the id already includes `.md`).
 * Returns `true` if a file was removed, `false` if the (valid) id had no file.
 * Reconciliation of the now-orphaned compiled page is deferred to the next
 * `compile`, consistent with how llmwiki already handles deleted sources —
 * this does not touch `wiki/`.
 */
export async function deleteSource(root: string, id: string): Promise<boolean> {
  assertSafeSourceId(id);
  try {
    await unlink(path.join(root, SOURCES_DIR, id));
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return false;
    throw err;
  }
}

export async function getSource(root: string, id: string): Promise<SourceRecord | null> {
  assertSafeSourceId(id);
  let content: string;
  try {
    content = await readFile(path.join(root, SOURCES_DIR, id), "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
  return toRecord(id, content, true);
}
