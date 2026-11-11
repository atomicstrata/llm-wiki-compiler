/**
 * @file src/storage/disk-record-directory.ts
 * @description Confined directory classification for a local project's record
 * directories (the review-candidate stores and the rule queue's). Moved
 * UNCHANGED from `src/compiler/candidate-store-paths.ts`, which re-exports
 * the binding function, the error class and the binding type, so each
 * importer, `instanceof` check and error name is what it was. The identity
 * type is exported here only; nothing imported it from the old module.
 *
 * Ordinary paths retain public in-root alias support. Explicit strict scans
 * require literal directories; both modes bind canonical paths and inodes and
 * reject escapes, broken links, non-directories and unavailable components.
 *
 * The names keep the word "candidate" because they are observable: the error's
 * `name` is matched by callers and tests. The mechanics know nothing about
 * candidates.
 */

import { lstat, realpath, stat } from "../utils/fs-metadata.js";
import type { Stats } from "node:fs";
import path from "node:path";
import { isInsideDir } from "../utils/path-confine.js";
import { portableRealpath } from "../utils/portable-realpath.js";

/** Stable identity captured for one literal candidate directory. */
export interface CandidateDirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

/** Canonical binding for one existing literal candidate directory. */
export interface CandidateDirectoryBinding {
  readonly dir: string;
  readonly realDir: string;
  readonly identity: CandidateDirectoryIdentity;
}

/** Typed refusal when a candidate namespace is not literal trusted authority. */
export class UnsafeCandidateDirError extends Error {
  constructor() {
    super("candidate store directory is unavailable");
    this.name = "UnsafeCandidateDirError";
  }
}

/** True only for a genuine lexical absence. */
function isAbsent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Split and validate one project-relative owned namespace. */
function ownedSegments(root: string, dir: string): string[] {
  const lexicalRoot = path.resolve(root);
  const target = path.resolve(lexicalRoot, dir);
  const relative = path.relative(lexicalRoot, target);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new UnsafeCandidateDirError();
  }
  return relative.split(path.sep).filter(Boolean);
}

/** Read one component without following a symlink. */
async function inspectComponent(component: string): Promise<Stats | null> {
  try {
    return await lstat(component);
  } catch (error) {
    if (isAbsent(error)) return null;
    throw new UnsafeCandidateDirError();
  }
}

/** Build and freeze the final directory binding. */
function binding(
  dir: string,
  realDir: string,
  info: Stats,
): CandidateDirectoryBinding {
  return Object.freeze({
    dir,
    realDir,
    identity: Object.freeze({ dev: info.dev, ino: info.ino }),
  });
}

/**
 * Bind a confined candidate directory, optionally requiring literal components.
 * Inspect each component with lstat before resolving aliases, so broken links
 * cannot collapse into apparent absence and outside-root targets are rejected.
 */
export async function captureCandidateDirectoryBinding(
  root: string,
  dir: string,
  requireLiteral = false,
): Promise<CandidateDirectoryBinding | null> {
  const segments = ownedSegments(root, dir);
  const realRoot = await realpath(root).catch(() => null);
  if (realRoot === null) throw new UnsafeCandidateDirError();
  let lexical = path.resolve(root);
  let finalInfo: Stats | null = null;
  let realDir = realRoot;
  for (let index = 0; index < segments.length; index += 1) {
    lexical = path.join(lexical, segments[index]!);
    finalInfo = await inspectComponent(lexical);
    if (finalInfo === null) return null;
    const expected = path.join(realRoot, ...segments.slice(0, index + 1));
    const observed = await resolveComponent(lexical, realRoot, requireLiteral ? expected : undefined, finalInfo);
    if (finalInfo.isSymbolicLink()) finalInfo = await stat(observed);
    if (!finalInfo.isDirectory()) throw new UnsafeCandidateDirError();
    realDir = observed;
  }
  if (finalInfo === null) throw new UnsafeCandidateDirError();
  return binding(lexical, realDir, finalInfo);
}

/** Resolve one observed component under the root, enforcing literal mode when requested. */
async function resolveComponent(lexical: string, realRoot: string, expected: string | undefined, info: Stats): Promise<string> {
  if (expected !== undefined && info.isSymbolicLink()) throw new UnsafeCandidateDirError();
  const observed = await portableRealpath(lexical).catch(() => null);
  if (observed === null || !isInsideDir(observed, realRoot)) throw new UnsafeCandidateDirError();
  if (expected !== undefined && observed !== expected) throw new UnsafeCandidateDirError();
  return observed;
}
