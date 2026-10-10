/**
 * Source file hashing for change detection.
 * Computes SHA-256 hashes of source files and compares them against
 * previously stored state to determine which files need recompilation.
 * This enables incremental compilation — only changed or new sources
 * are sent through the LLM pipeline.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "fs";
import { open } from "fs/promises";
import path from "path";
import { SOURCES_DIR } from "../utils/constants.js";
import type { WikiState, SourceChange } from "../utils/types.js";
import { listSelectedSourceFiles } from "../sources/scan.js";
import { isSourceSelected, loadSourceSelection, type SourceSelection } from "../sources/selection.js";

/** Thrown by {@link hashFile} for a path that is not a regular file (a named pipe, directory or device). */
export class NotRegularFileError extends Error {
  constructor(filePath: string) {
    super(`Not a regular file: ${filePath}`);
    this.name = "NotRegularFileError";
  }
}

/**
 * Read a file and compute its SHA-256 hash.
 *
 * The file is opened non-blocking and checked on the open handle before any
 * read: opening a named pipe for reading otherwise waits forever for a writer,
 * which would hang whichever command or viewer refresh was hashing sources.
 *
 * @param filePath - Absolute path to the file to hash.
 * @returns Hex-encoded SHA-256 digest of the file contents.
 * @throws {NotRegularFileError} When the path is not a regular file.
 */
export async function hashFile(filePath: string): Promise<string> {
  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new NotRegularFileError(filePath);
    const content = await handle.readFile("utf-8");
    return createHash("sha256").update(content).digest("hex");
  } finally {
    await handle.close();
  }
}

/**
 * Scan the sources/ directory and compare file hashes against previous state
 * to identify new, changed, unchanged, and deleted source files.
 * @param root - Project root directory containing the sources/ folder.
 * @param prevState - The previously persisted WikiState to compare against.
 * @returns Array of SourceChange entries describing each file's status.
 */
export async function detectChanges(
  root: string,
  prevState: WikiState,
): Promise<SourceChange[]> {
  const selection = await loadSourceSelection(root);
  const currentFiles = await listSelectedSourceFiles(root, selection);
  const changes: SourceChange[] = [];

  for (const file of currentFiles) {
    const status = await classifyFile(root, file, prevState);
    changes.push({ file, status });
  }

  const deletedChanges = findDeletedFiles(currentFiles, prevState, selection);
  changes.push(...deletedChanges);

  return changes;
}

/**
 * Classify a single source file as new, changed, or unchanged.
 * @param root - Project root directory.
 * @param file - Filename within sources/.
 * @param prevState - Previous compilation state.
 * @returns The change status for this file.
 */
async function classifyFile(
  root: string,
  file: string,
  prevState: WikiState,
): Promise<SourceChange["status"]> {
  const filePath = path.join(root, SOURCES_DIR, file);
  const hash = await hashFile(filePath);
  const prev = prevState.sources[file];

  if (!prev) return "new";
  if (prev.hash !== hash) return "changed";
  return "unchanged";
}

/**
 * Retire prior source contributions that disappeared or are no longer selected.
 * @param currentFiles - Selected regular Markdown files currently on disk.
 * @param prevState - Previous compilation state.
 * @returns Array of SourceChange entries for deleted files.
 */
function findDeletedFiles(
  currentFiles: string[],
  prevState: WikiState,
  selection: SourceSelection,
): SourceChange[] {
  const currentSet = new Set(currentFiles);
  return Object.keys(prevState.sources)
    .filter((file) => !currentSet.has(file))
    .map((file) => ({ file, status: "deleted" as const,
      ...(!isSourceSelected(file, selection) ? { reason: "deselected" as const } : {}),
    }));
}
