/**
 * Source file hashing for change detection.
 * Computes SHA-256 hashes of source files and compares them against
 * previously stored state to determine which files need recompilation.
 * This enables incremental compilation — only changed or new sources
 * are sent through the LLM pipeline.
 */

import { createHash } from "node:crypto";
import path from "path";
import { diskLocalReads } from "../storage/disk-local-reads.js";
import { readRegularLocationText } from "../storage/disk-locations.js";
import type { LegacyLocalReads } from "../storage/legacy-local-reads.js";
import { SOURCES_DIR } from "../utils/constants.js";
import type { WikiState, SourceChange } from "../utils/types.js";
import { listSelectedSourceFilesFrom } from "../sources/scan.js";
import { prefetchInOrder } from "../utils/prefetch-in-order.js";
import { isSourceSelected, loadSourceSelectionFrom, type SourceSelection } from "../sources/selection.js";

// Re-exported where `hashFile` callers have always imported it from.
export { NotRegularFileError } from "../storage/disk-locations.js";

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
  const content = await readRegularLocationText(filePath);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Reads one source's text for HASHING, by its project-relative path
 * (`sources/<file>`). Kept apart from the generic content reads so the local
 * disk can hash without blocking (see {@link diskSourceHashText}) while every
 * other page and configuration read goes through the ordinary binding.
 */
export type SourceHashText = (relPath: string) => Promise<string>;

/**
 * LOCAL DISK. Source text for hashing under `root`, through the same
 * non-blocking regular-file read as {@link hashFile}: a named pipe, directory
 * or device rejects with {@link NotRegularFileError} instead of hanging.
 */
export function diskSourceHashText(root: string): SourceHashText {
  return (relPath) => readRegularLocationText(path.join(root, relPath));
}

/** SHA-256 hex of one source's text, read through `readText`. */
export async function hashSourceFrom(readText: SourceHashText, file: string): Promise<string> {
  const content = await readText(path.join(SOURCES_DIR, file));
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Scan the sources/ directory and compare file hashes against previous state
 * to identify new, changed, unchanged, and deleted source files.
 * @param root - Project root directory containing the sources/ folder.
 * @param prevState - The previously persisted WikiState to compare against.
 * @returns Array of SourceChange entries describing each file's status.
 */
export function detectChanges(
  root: string,
  prevState: WikiState,
): Promise<SourceChange[]> {
  return detectChangesFrom(diskLocalReads(root), prevState, diskSourceHashText(root));
}

/**
 * The same classification, with the selection and listing read through
 * `reads` and each source hashed from `hashText` (by default, `reads` too).
 */
export async function detectChangesFrom(
  reads: LegacyLocalReads,
  prevState: WikiState,
  hashText: SourceHashText = (relPath) => reads.readText(relPath),
): Promise<SourceChange[]> {
  const selection = await loadSourceSelectionFrom(reads);
  const currentFiles = await listSelectedSourceFilesFrom(reads, selection);
  // Reads start in parallel but are taken in listing order, so the first
  // failing source still rejects the detection where the loop reached it.
  const hashed: HashedSource[] = [];
  const pending = prefetchInOrder(currentFiles, (file) => hashSourceFrom(hashText, file));
  for (const [index, file] of currentFiles.entries()) {
    hashed.push({ file, hash: await pending[index] });
  }
  return changesFromHashes(hashed, prevState, selection);
}

/** One selected source and the hash of its current text. */
interface HashedSource {
  file: string;
  hash: string;
}

/**
 * Classify already-hashed sources against the previous state. Pure: however
 * the sources were read and hashed, the new/changed/unchanged/deleted
 * decisions come from this one function.
 *
 * @param hashed - Every selected source with its current hash, in listing order.
 * @param prevState - The previously persisted WikiState to compare against.
 * @param selection - The selection the listing was made under.
 */
function changesFromHashes(
  hashed: readonly HashedSource[],
  prevState: WikiState,
  selection: SourceSelection,
): SourceChange[] {
  const changes: SourceChange[] = hashed.map(({ file, hash }) => ({
    file, status: classifyHash(prevState.sources[file]?.hash, hash),
  }));
  changes.push(...findDeletedFiles(hashed.map(({ file }) => file), prevState, selection));
  return changes;
}

/** Classify one source as new, changed, or unchanged from its previous hash. */
function classifyHash(previous: string | undefined, hash: string): SourceChange["status"] {
  if (previous === undefined) return "new";
  return previous === hash ? "unchanged" : "changed";
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
