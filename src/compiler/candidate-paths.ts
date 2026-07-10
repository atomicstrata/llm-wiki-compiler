/**
 * Shared candidate-store path resolution for the review pipeline.
 *
 * Both the WRITE side ({@link file://./candidates.ts}) and the READ side
 * ({@link file://./candidate-read.ts}) of the candidate store need to turn a
 * candidate id into a confined absolute JSON path. Hosting those resolvers here
 * — rather than in either of the two larger modules — lets the read and write
 * modules import the same primitives WITHOUT forming an import cycle (the read
 * module re-exported back through `candidates.ts` would otherwise close a loop).
 *
 * The resolvers delegate to {@link confinedCandidateFilePath}, so a safe id under
 * a NORMAL (real) candidates dir yields a byte-identical path to `path.join`
 * (default parity preserved); an unsafe id throws {@link UnsafeCandidateIdError},
 * and a symlinked containing dir escaping root throws — both before any I/O.
 */

import { confinedCandidateFilePath } from "./candidate-store-paths.js";
import {
  CANDIDATES_DIR,
  CANDIDATES_ARCHIVE_DIR,
} from "../utils/constants.js";

/**
 * Thrown when a candidate id or slug is not a single safe path component, so a
 * traversal-bearing value (e.g. `../evil`) can never be joined into a candidate
 * file path that escapes `.llmwiki/candidates/`. Default slugs from `slugify`
 * are already filename-safe, so this never fires on the default path.
 */
export class UnsafeCandidateIdError extends Error {
  constructor(kind: "id" | "slug", value: string) {
    super(`unsafe candidate ${kind}: ${JSON.stringify(value)} is not a single safe path component`);
    this.name = "UnsafeCandidateIdError";
  }
}

/** Build the typed unsafe-id error for a candidate file id. */
function unsafeCandidateId(id: string): Error {
  return new UnsafeCandidateIdError("id", id);
}

/**
 * Resolve a candidate file path under `dir`, asserting `id` is a single safe
 * filename component AND REALPATH-confining the result under the project root via
 * {@link confinedCandidateFilePath}. Defense in depth: a safe id under a NORMAL
 * (real) candidates dir yields a byte-identical path to `path.join`, so default
 * parity is preserved; an unsafe id throws {@link UnsafeCandidateIdError}, and a
 * symlinked containing dir escaping root throws {@link UnsafeCandidateDirError} —
 * both before any I/O.
 * @param root - Project root directory.
 * @param dir - Candidates subdir (pending or archive) relative to root.
 * @param id - Candidate id to embed as the filename stem.
 */
function resolveCandidatePath(root: string, dir: string, id: string): Promise<string> {
  return confinedCandidateFilePath(root, dir, id, unsafeCandidateId);
}

/** Absolute confined path to a candidate's JSON file. */
export function candidatePath(root: string, id: string): Promise<string> {
  return resolveCandidatePath(root, CANDIDATES_DIR, id);
}

/** Absolute confined path to the archived JSON file for a rejected candidate. */
export function archivePath(root: string, id: string): Promise<string> {
  return resolveCandidatePath(root, CANDIDATES_ARCHIVE_DIR, id);
}
