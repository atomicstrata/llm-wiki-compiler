/**
 * @file src/storage/disk-local-record-dirs.ts
 * @description The local-directory implementation of
 * {@link LegacyLocalRecordDirs}.
 *
 * Each method runs the sequence the candidate store ran inline before the
 * binding existed, on the same arguments:
 *
 *  - a directory is the confined directory binding's real directory, so an
 *    in-root alias still resolves, and an escape, a broken link or a
 *    non-directory component is still refused with the typed error;
 *  - a leaf is that same directory check followed by confinement of the leaf's
 *    location under the project, any failure reported as the same typed error.
 *    A leaf that is a link to a target inside the project is read through it;
 *    one whose link escapes the project is refused when it is resolved;
 *  - the listing and the read are the plain Node calls, whose errors pass
 *    through untouched for the caller to interpret.
 */

import { existsSync, type Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { confineUnderRoot, isInsideDir, safeRealpath } from "../utils/path-confine.js";
import { captureCandidateDirectoryBinding, captureCandidateDirectoryUnderRoot, UnsafeCandidateDirError } from "./disk-record-directory.js";
import type { LocalEntryKind } from "./legacy-local-reads.js";
import type { LegacyLocalRecordDirs, LocalRecordDirectory, LocalRecordLeaf } from "./legacy-local-record-dirs.js";

/** What one listed entry is, without following a link. */
function kindOf(entry: Dirent): LocalEntryKind {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  return entry.isSymbolicLink() ? "link" : "other";
}

/**
 * The tolerant view of a directory that is ALREADY resolved.
 *
 * @param realDir - Absolute directory, as the confined resolution returned it.
 */
export function diskRecordDirectory(realDir: string): LocalRecordDirectory {
  return {
    exists: async () => existsSync(realDir),
    listEntries: async () => {
      const entries = await readdir(realDir, { withFileTypes: true });
      return entries.map((entry) => ({ name: entry.name, kind: kindOf(entry) }));
    },
  };
}

/**
 * Resolve one leaf: the directory check, then confinement of its location under
 * the project.
 *
 * The confinement is `confineUnderRoot(relDir/fileName, root, { mustExist: false })`
 * with what the directory check already proved taken from it: the real root
 * (resolved once, by the check) and, when the directory exists, that its real
 * path is inside that root. So a bound directory leaves only the leaf itself
 * to resolve: a leaf that resolves must stay inside the root, and one that does
 * not resolve has the bound directory as its nearest existing ancestor. An
 * absent directory takes the full ancestor walk.
 */
async function resolveDiskLeaf(root: string, relDir: string, fileName: string): Promise<LocalRecordLeaf> {
  const { realRoot, binding } = await captureCandidateDirectoryUnderRoot(root, relDir);
  const relLeaf = path.join(relDir, fileName);
  let location: string;
  try {
    location = binding === null
      ? await confineUnderRoot(relLeaf, root, { mustExist: false })
      : await confineLeafOfBoundDirectory(relLeaf, realRoot);
  } catch {
    throw new UnsafeCandidateDirError();
  }
  return { location, readText: () => readFile(location, "utf-8") };
}

/** The leaf's absolute path under `realRoot`, refused when it, or its resolved target, escapes. */
async function confineLeafOfBoundDirectory(relLeaf: string, realRoot: string): Promise<string> {
  const location = path.normalize(path.resolve(realRoot, relLeaf));
  if (!isInsideDir(location, realRoot)) throw new UnsafeCandidateDirError();
  const real = await safeRealpath(location);
  if (real !== null && !isInsideDir(real, realRoot)) throw new UnsafeCandidateDirError();
  return location;
}

/**
 * The record directories of an ordinary local project rooted at `root`.
 *
 * @param root - Project root directory, as the caller holds it (not canonicalized here).
 * @returns The binding every root-based tolerant candidate read is built from.
 */
export function diskLocalRecordDirs(root: string): LegacyLocalRecordDirs {
  return {
    directory: async (relDir) => {
      const realDir = (await captureCandidateDirectoryBinding(root, relDir))?.realDir ?? null;
      return realDir === null ? null : diskRecordDirectory(realDir);
    },
    leaf: (relDir, fileName) => resolveDiskLeaf(root, relDir, fileName),
  };
}
