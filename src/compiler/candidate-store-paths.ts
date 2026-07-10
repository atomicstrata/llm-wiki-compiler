/**
 * @file src/compiler/candidate-store-paths.ts
 * @description Realpath-confinement helpers for the review candidate store.
 *
 * The candidate store persists one JSON file per candidate under
 * `.llmwiki/candidates/` (and archives rejected ones under `…/archive/`). Path
 * resolution here is the single trust boundary for that store: it must reject a
 * SYMLINKED `.llmwiki/candidates` (or a symlinked `.llmwiki`) that would redirect
 * every read/write/delete/archive OUTSIDE the project root — the same
 * containing-directory escape class already closed for the intent journal
 * (`resolveConfinedJournalDir`) and `state reset`.
 *
 * Two primitives, both fail-closed:
 *
 *  - {@link confinedCandidateFilePath} confines a single candidate FILE path under
 *    root via {@link confineUnderRoot} (which realpath-confines the nearest
 *    existing ancestor). For a NORMAL (real) candidates dir the confined path
 *    equals the lexical `path.join` result → default candidate JSON stays
 *    byte-identical. A symlinked containing dir is detected and THROWS.
 *  - {@link resolveConfinedCandidatesDir} resolves the candidates/archive DIRECTORY
 *    realpath for listing/scanning: returns null when the dir is ABSENT (today's
 *    "no candidates" behavior) and THROWS when it EXISTS but escapes root, so a
 *    list/scan never `readdir`s through an escaping symlink.
 */

import path from "path";
import {
  confineUnderRoot,
  safeRealpath,
  isInsideDir,
} from "../utils/path-confine.js";
import { isSafeFilenameComponent } from "../profile/identity.js";

/**
 * Thrown when the candidate store's containing directory (`.llmwiki/candidates`
 * or `…/archive`, or the `.llmwiki` parent) is a symlink/path that escapes the
 * project root, so a read/write/delete/archive/list would operate OUTSIDE the
 * project. Fails CLOSED before any I/O. A NORMAL real directory never trips this.
 */
export class UnsafeCandidateDirError extends Error {
  constructor(dir: string) {
    super(`candidate store directory escapes the project root: ${JSON.stringify(dir)}`);
    this.name = "UnsafeCandidateDirError";
  }
}

/** Extension used for all candidate JSON files. */
const CANDIDATE_EXT = ".json";

/**
 * Resolve the confined absolute path of the candidate file `${id}.json` under
 * `dir` (relative to `root`). Asserts `id` is a single safe filename component,
 * then confines the FINAL file path under root via {@link confineUnderRoot} — so a
 * symlinked containing dir (whose realpath is the nearest existing ancestor) is
 * detected and rejected. A normal real dir yields the byte-identical lexical path.
 *
 * @param root - Absolute project root directory.
 * @param dir - Candidates subdir (pending or archive) relative to root.
 * @param id - Candidate id (the filename stem); must be a safe path component.
 * @param onUnsafeId - Called to build the typed error thrown for an unsafe id.
 * @returns The confined absolute candidate file path.
 * @throws The error from `onUnsafeId` when `id` is not a safe path component.
 * @throws {UnsafeCandidateDirError} When the containing dir escapes root.
 */
export async function confinedCandidateFilePath(
  root: string,
  dir: string,
  id: string,
  onUnsafeId: (id: string) => Error,
): Promise<string> {
  if (!isSafeFilenameComponent(id)) throw onUnsafeId(id);
  // Confine the project-RELATIVE path so confinement is invariant to which
  // symlink form of root it is resolved under (e.g. `/var/...` vs the canonical
  // `/private/var/...` on macOS); an absolute target would otherwise resolve to
  // the non-canonical form and spuriously read as escaping.
  const relPath = path.join(dir, `${id}${CANDIDATE_EXT}`);
  try {
    return await confineUnderRoot(relPath, root, { mustExist: false });
  } catch {
    throw new UnsafeCandidateDirError(path.join(root, dir));
  }
}

/**
 * Resolve the candidates/archive DIRECTORY's realpath for listing/scanning,
 * mirroring `resolveConfinedJournalDir`. Returns null when the directory is
 * ABSENT (nothing to list — today's empty-list behavior) and THROWS
 * {@link UnsafeCandidateDirError} when it EXISTS but its realpath escapes root, so
 * a list/scan NEVER `readdir`s through an escaping symlink.
 *
 * @param root - Absolute project root directory.
 * @param dir - Candidates subdir (pending or archive) relative to root.
 * @returns The confined real directory, or null when absent.
 * @throws {UnsafeCandidateDirError} When the dir exists but escapes root.
 */
export async function resolveConfinedCandidatesDir(
  root: string,
  dir: string,
): Promise<string | null> {
  const target = path.join(root, dir);
  const realDir = await safeRealpath(target);
  if (realDir === null) return null; // absent → nothing to list
  const realRoot = (await safeRealpath(root)) ?? path.resolve(root);
  if (!isInsideDir(realDir, realRoot)) throw new UnsafeCandidateDirError(target);
  return realDir;
}
