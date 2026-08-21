/**
 * @file src/sources/store.ts
 * @description Source-store I/O API for the llmwiki SDK: list / get / delete
 * sources under `sources/`. Source IDs are bare basenames including `.md` (e.g.
 * "note.md") — opaque, path-safe, never joined with an extra extension. The pure
 * record/guard logic lives in `./source-record.js`; this module is the thin
 * filesystem layer over it. Read-only-ish (delete aside), no LLM.
 */
import path from "path";
import { lstat, readdir, readFile, unlink } from "fs/promises";
import { confinedRegularFile, resolveSourcesDir } from "../utils/path-confine.js";
import {
  assertSafeSourceId,
  toRecord,
  type SourceRecord,
  type ListSourcesOptions,
  type ListSourcesResult,
} from "./source-record.js";

export type { SourceRecord, ListSourcesOptions, ListSourcesResult } from "./source-record.js";

export async function listSources(root: string, options: ListSourcesOptions = {}): Promise<ListSourcesResult> {
  const dir = await resolveSourcesDir(root);
  if (dir === null) return { sources: [] };
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
    // Skip any entry that is not a confined regular file (symlinks — whether
    // escaping or in-tree aliases — are never sources).
    const real = await confinedRegularFile(dir, id);
    if (real === null) continue;
    const content = await readFile(real, "utf-8");
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
  const dir = await resolveSourcesDir(root);
  if (dir === null) return false;
  // Not a confined regular file (missing, symlink, or directory) → nothing to delete.
  // Keeps delete coherent with getSource/listSources.
  const real = await confinedRegularFile(dir, id);
  if (real === null) return false;
  try {
    await unlink(path.join(dir, id));
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * True when `sources/<id>` is genuinely ABSENT — nothing at that path at all.
 *
 * Deliberately narrower than "`getSource` returned null", which also covers
 * present-but-not-a-valid-source: a symlink, a directory, an unreadable entry.
 * `llmwiki rm` needs the distinction to tell "a previous removal already
 * unlinked this file" (resumable — see `planRemoval` in `./removal.ts`) from
 * "this name is occupied by something that was never a source" (not
 * resumable, and never silently deleted around).
 *
 * `lstat`, not `stat`: a DANGLING symlink is present, not absent, and must not
 * be mistaken for an interrupted removal.
 *
 * @param root - Absolute project root.
 * @param id - Bare source basename including `.md`.
 * @returns `true` when nothing exists at `sources/<id>`, `false` when
 *   something does — of any kind.
 */
export async function sourceFileMissing(root: string, id: string): Promise<boolean> {
  assertSafeSourceId(id);
  const dir = await resolveSourcesDir(root);
  if (dir === null) return true;
  try {
    await lstat(path.join(dir, id));
    return false;
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return true;
    throw err;
  }
}

export async function getSource(root: string, id: string): Promise<SourceRecord | null> {
  assertSafeSourceId(id);
  const dir = await resolveSourcesDir(root);
  if (dir === null) return null;
  // Only confined regular files are valid sources (symlinks — in-tree or escaping — are not).
  const real = await confinedRegularFile(dir, id);
  if (real === null) return null;
  let content: string;
  try {
    content = await readFile(real, "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
  return toRecord(id, content, true);
}
