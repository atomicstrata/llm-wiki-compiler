/**
 * Shared filesystem primitives for candidate queues.
 *
 * Both the concept review queue (`compiler/candidates.ts`) and the rule
 * candidate queue (`compiler/rule-candidates.ts`) persist one JSON file per
 * candidate under a directory, list those files, and move rejected records
 * into an archive subdirectory. These two operations were identical across the
 * queues; extracting them here removes the duplication while keeping each
 * queue's own id/shape logic local to its module.
 */

import { readdir, rename, unlink, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { safeReadFile } from "./markdown.js";

/** Extension used for all candidate JSON files. */
export const CANDIDATE_JSON_EXT = ".json";

/**
 * Turn a dotted candidate id into a single filesystem-safe path segment.
 *
 * Only characters outside `[a-z0-9._-]` are replaced (with `_`); dots are
 * PRESERVED. Collapsing dots to `-` (the old behavior) made `rulecand.a.b-c`
 * and `rulecand.a-b.c` map to the same file, silently overwriting one
 * candidate with the other. Keeping dots makes the mapping injective for the
 * ids this codebase emits (category in `[a-z0-9_]`, slug in `[a-z0-9-]`).
 * @param candidateId - The dotted candidate id.
 */
export function candidateFileId(candidateId: string): string {
  return candidateId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * List the file ids (basename without `.json`) of every candidate JSON file in
 * a directory, ignoring subdirectories (e.g. an `archive/` folder). Returns an
 * empty list when the directory does not exist.
 * @param dir - Absolute path to the candidate directory.
 */
export async function listCandidateFileIds(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(CANDIDATE_JSON_EXT)) continue;
    ids.push(entry.name.slice(0, -CANDIDATE_JSON_EXT.length));
  }
  return ids;
}

/**
 * Move a candidate JSON file into an archive location, creating the archive
 * directory if needed. Falls back to copy + unlink when `rename` fails across
 * filesystems. Returns false when the source file does not exist.
 * @param sourcePath - Absolute path of the pending candidate file.
 * @param targetPath - Absolute archive destination path.
 */
export async function moveCandidateToArchive(
  sourcePath: string,
  targetPath: string,
): Promise<boolean> {
  if (!existsSync(sourcePath)) return false;
  await mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await rename(sourcePath, targetPath);
  } catch {
    const raw = await safeReadFile(sourcePath);
    await writeFile(targetPath, raw, "utf-8");
    await unlink(sourcePath);
  }
  return true;
}
