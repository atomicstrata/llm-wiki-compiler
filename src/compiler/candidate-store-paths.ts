/**
 * @file src/compiler/candidate-store-paths.ts
 * @description Confined directory classification for review candidate stores.
 * Ordinary paths retain public in-root alias support. Explicit strict scans
 * require literal directories; both modes bind canonical paths and inodes and
 * reject escapes, broken links, non-directories and unavailable components.
 */

import { lstat, realpath, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { isSafeFilenameComponent } from "../profile/identity.js";
import { confineUnderRoot, isInsideDir } from "../utils/path-confine.js";

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

/** Extension used for every candidate JSON file. */
const CANDIDATE_EXT = ".json";

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
  const observed = await realpath(lexical).catch(() => null);
  if (observed === null || !isInsideDir(observed, realRoot)) throw new UnsafeCandidateDirError();
  if (expected !== undefined && observed !== expected) throw new UnsafeCandidateDirError();
  return observed;
}

/** Resolve a safe candidate leaf while retaining the public lexical path form. */
export async function confinedCandidateFilePath(
  root: string,
  dir: string,
  id: string,
  onUnsafeId: (id: string) => Error,
): Promise<string> {
  if (!isSafeFilenameComponent(id)) throw onUnsafeId(id);
  await captureCandidateDirectoryBinding(root, dir);
  try {
    return await confineUnderRoot(path.join(dir, `${id}${CANDIDATE_EXT}`), root, { mustExist: false });
  } catch {
    throw new UnsafeCandidateDirError();
  }
}

/** Resolve one confined candidate directory, including in-root aliases. */
export async function resolveConfinedCandidatesDir(
  root: string,
  dir: string,
): Promise<string | null> {
  return (await captureCandidateDirectoryBinding(root, dir))?.realDir ?? null;
}
