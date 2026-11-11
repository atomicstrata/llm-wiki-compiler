/**
 * @file src/storage/disk-local-reads.ts
 * @description The local-directory implementation of {@link LegacyLocalReads}.
 *
 * Each method makes the Node call the compile made inline before the binding
 * existed, on the same absolute path, and lets that call's own error through
 * untouched. The two confined reads are the incumbent exact-directory,
 * handle-bound, no-follow page readers, moved here unchanged: the root is
 * canonicalized, the file must resolve inside its expected directory, and the
 * bytes come from the opened handle. An escaping path is dropped BEFORE any
 * read, so out-of-tree content can never reach a prompt or a planned write.
 *
 * {@link readConfinedPageThrough} is beside them for a caller that must read
 * only part of a page through the same handle-bound proof. It lends the
 * caller a Node `FileHandle`, so it is a LOCAL DISK function only: it is not
 * part of {@link LegacyLocalReads} and no hosted store can offer it.
 *
 * {@link readConfinedPageText} is the whole-text sibling of that function for
 * a caller that keeps the path it resolved; it is likewise outside the binding.
 *
 * {@link locationKindNoFollow} is here only because the projection from an
 * `lstat` result to a kind lives here. Unlike the binding's methods it is not
 * relative to a project: it takes a location exactly as the caller gives it,
 * resolves and confines NOTHING, and checks no root or parent.
 *
 * {@link diskLocalEntityScans} is the local-directory implementation of
 * {@link LegacyLocalEntityScans}: the root, directory and entry checks the
 * shared entity scan made inline before, in the same order, unchanged.
 */

import { existsSync, type Dirent, type Stats } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  readConfinedLeaf, readConfinedPage, readConfinedPageOutcome, readConfinedPageWith, type ConfinedPageRead, type ReadConfinedPageOptions,
} from "../utils/confined-read.js";
import { isInsideDir, resolveRealDir, safeRealpath } from "../utils/path-confine.js";
import { listDirectoryNames } from "./disk-guarded-leaves.js";
import { readLocationPrefix, readLocationText } from "./disk-locations.js";
import type {
  ConfinedReadResult,
  EntityDirectoryOpen,
  LegacyLocalCappedReads,
  LegacyLocalEntityScans,
  LegacyLocalReads,
  LocalDirectory,
  LocalEntityDirectory,
  LocalEntryKind,
} from "./legacy-local-reads.js";

/** Project the kind of an entry from the predicates `Dirent` and `Stats` share. */
function entryKind(entry: Dirent | Stats): LocalEntryKind {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  if (entry.isSymbolicLink()) return "link";
  return "other";
}

/**
 * NO GUARD. What is at `location`, by ONE `lstat`, so a final link is reported
 * as `"link"` and not followed: `"file"`, `"directory"`, `"link"` or `"other"`.
 * The location is used as given; parent directories are followed and nothing
 * is confined. REJECTS with the raw error when nothing is there (`ENOENT`) or
 * the lookup fails; the caller decides what that means. A snapshot only.
 */
export async function locationKindNoFollow(location: string): Promise<LocalEntryKind> {
  return entryKind(await lstat(location));
}

/**
 * Read the exact `filePath` confined to `expectedDir` through the handle-bound,
 * no-follow {@link readConfinedPage}. Returns `{dropped:"escapes-dir"}` if the
 * realpath is missing or escapes the dir (never reads the target), or
 * `{dropped:"unreadable"}` if the confined read itself fails closed.
 *
 * The confined read begins by resolving the path it is given and refusing it
 * as absent unless that path is already its own real path inside the
 * directory. So `filePath` is offered to it first: a page that is its own
 * real path (the common case) is resolved once, by the read, instead of once
 * here and again there. Only an absent answer falls back to resolving here,
 * which separates an escape or a missing page from an in-directory link, read
 * through its target as before; a page that resolves to itself got its
 * confined read already, and an absent read of it is unreadable, as it was.
 */
export async function readConfinedExactFile(
  expectedDir: string,
  filePath: string,
): Promise<ConfinedReadResult> {
  const direct = await readConfinedPageOutcome(filePath, expectedDir);
  if (direct.kind === "ok") return { content: direct.body };
  if (direct.kind === "unreadable") return { dropped: "unreadable" };
  const real = await safeRealpath(filePath);
  if (!real || !isInsideDir(real, expectedDir)) return { dropped: "escapes-dir" };
  const content = real === filePath ? null : await readConfinedPage(real, expectedDir);
  if (content === null) return { dropped: "unreadable" };
  return { content };
}

/**
 * CARRIES THE CONFINED PAGE READ'S GUARD, LOCAL DISK ONLY. `readConfinedPageWith`
 * with the same four arguments, returning its promise itself: the file at
 * `capturedRealpath` is opened without following a link and without blocking,
 * must be a regular file still bound to that path inside
 * `expectedCanonicalDir`, and is then lent to `read`, which may read as little
 * as it needs. The primitive closes the handle in `finally`; `read` must not.
 * `opts` pass through unchanged, `strictIo` included. A confinement refusal is
 * `absent`; a raw I/O error from the open, from the checks made on the open
 * handle, or from `read`, is `unreadable` with its cause.
 *
 * ONE CASE REJECTS. The primitive first resolves `capturedRealpath` again,
 * before it opens anything and outside its `try`. With `strictIo` that first
 * resolve REJECTS with the raw error on a genuine fault (anything other than
 * `ENOENT`, `ENOTDIR` or `ELOOP`, for example `EACCES`). Without `strictIo`
 * every failure of that resolve is `absent`, and nothing rejects.
 */
export function readConfinedPageThrough<T>(
  capturedRealpath: string,
  expectedCanonicalDir: string,
  read: (handle: FileHandle) => Promise<T>,
  opts: ReadConfinedPageOptions = {},
): Promise<{ kind: "ok"; value: T } | Exclude<ConfinedPageRead, { kind: "ok" }>> {
  return readConfinedPageWith(capturedRealpath, expectedCanonicalDir, read, opts);
}

/**
 * CARRIES THE CONFINED PAGE READ'S GUARD, LOCAL DISK ONLY. `readConfinedPage`
 * with the same two arguments, returning its promise itself: the whole text of
 * the page at `capturedRealpath`, or `null`. It is for a caller that has
 * ALREADY resolved the page and checked it is inside `expectedCanonicalDir`,
 * and that goes on to use that resolved path; it makes no resolve of its own
 * beyond the primitive's. `null` covers every refusal and every read failure
 * alike (absent, escaping, a link, not a regular file, an open race, an I/O
 * error): the caller cannot tell them apart, and nothing rejects.
 */
export function readConfinedPageText(capturedRealpath: string, expectedCanonicalDir: string): Promise<string | null> {
  return readConfinedPage(capturedRealpath, expectedCanonicalDir);
}

/**
 * The project root's real path, looked up once per binding: a binding serves
 * one operation, and every page read of that operation would otherwise
 * resolve the same root again. Only a resolved root is kept, so a root that
 * does not exist yet is looked up again on the next read. Keeping it is safe
 * for the same reason the scan directories are kept: each read's post-open
 * check re-resolves the page and requires it inside the directory derived
 * from this root.
 */
function canonicalRootOf(root: string): () => Promise<string | null> {
  let resolved: string | undefined;
  return async () => (resolved ??= (await safeRealpath(root)) ?? undefined) ?? null;
}

/** `<root>/<relDir>/<slug>.md`, confined to `<canonical root>/<relDir>`. */
async function readDiskConfinedPage(canonicalRoot: string | null, relDir: string, slug: string): Promise<ConfinedReadResult> {
  if (!canonicalRoot) return { dropped: "no-root" };
  const expectedDir = path.join(canonicalRoot, relDir);
  const filePath = path.join(expectedDir, `${slug}.md`);
  return readConfinedExactFile(expectedDir, filePath);
}

/** `<root>/<relPath>`, confined to its own parent directory under the canonical root. */
async function readDiskConfinedFile(canonicalRoot: string | null, relPath: string): Promise<ConfinedReadResult> {
  if (!canonicalRoot) return { dropped: "no-root" };
  const expectedDir = path.join(canonicalRoot, path.dirname(relPath));
  const filePath = path.join(canonicalRoot, relPath);
  return readConfinedExactFile(expectedDir, filePath);
}

/** Listings anchored at an already-verified canonical directory. */
function diskDirectory(canonicalDir: string): LocalDirectory {
  return {
    listEntries: async (relative) => {
      const entries = await readdir(path.join(canonicalDir, relative), { withFileTypes: true });
      // Name order, as Node's libuv listed them (Bun returns raw directory
      // order). Names in one directory are unique, so no tie case.
      return entries.map((entry) => ({ name: entry.name, kind: entryKind(entry) }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
    },
  };
}

/**
 * The reads of an ordinary local project rooted at `root`.
 *
 * @param root - Project root directory, as the caller holds it (not canonicalized here).
 * @returns The binding every root-based reader builds its reads from.
 */
export function diskLocalReads(root: string): LegacyLocalReads {
  const locate = (relPath: string): string => path.join(root, relPath);
  const canonicalRoot = canonicalRootOf(root);
  return {
    readText: (relPath) => readFile(locate(relPath), "utf-8"),
    exists: async (relPath) => existsSync(locate(relPath)),
    statNoFollow: async (relPath) => entryKind(await lstat(locate(relPath))),
    listNames: (relDir) => listDirectoryNames(locate(relDir)),
    realDirectory: async (relDir) => {
      const canonicalDir = await resolveRealDir(root, relDir);
      return canonicalDir === null ? null : diskDirectory(canonicalDir);
    },
    readConfinedPage: async (relDir, slug) => readDiskConfinedPage(await canonicalRoot(), relDir, slug),
    readConfinedFile: async (relPath) => readDiskConfinedFile(await canonicalRoot(), relPath),
    locate,
  };
}

/**
 * The bounded reads of an ordinary local project rooted at `root`. Building
 * the binding does no I/O and no path work.
 *
 * `readCappedText` is the confined-read primitive, called with the root as the
 * caller holds it, the file at `<root>/<relPath>`, that file's own directory
 * as the expected directory, and the cap: four arguments, no options, and its
 * promise returned as it is. Every refusal is that primitive's.
 *
 * @param root - Project root directory, as the caller holds it (not canonicalized here).
 */
export function diskLocalCappedReads(root: string): LegacyLocalCappedReads {
  return {
    readCappedText: (relPath, maxBytes) => {
      const file = path.join(root, relPath);
      return readConfinedLeaf(root, file, path.dirname(file), maxBytes);
    },
  };
}

/**
 * The entity directory already verified at `expectedDir`, an absolute resolved
 * path. The listing is `readdir` in name order ({@link listDirectoryNames}).
 * An entry resolves to its real path, and only when that is inside `expectedDir`. The two reads follow links at the locator
 * they are given and check nothing again.
 */
function diskEntityDirectory(expectedDir: string): LocalEntityDirectory {
  return {
    listNames: () => listDirectoryNames(expectedDir),
    resolveEntry: async (name) => {
      const resolved = await safeRealpath(path.join(expectedDir, name));
      if (!resolved || !isInsideDir(resolved, expectedDir)) return null;
      return resolved;
    },
    readPrefix: (entry, maxBytes) => readLocationPrefix(entry, maxBytes),
    readText: (entry) => readLocationText(entry),
  };
}

/**
 * Open `<root>/<relDir>` as an entity directory. The root is resolved first; a
 * root that does not resolve is `invalid`. One no-follow `lstat` of the
 * expected path decides `missing` (ANY failure of it, and its kind is not
 * used), then the path must resolve to exactly itself or it is `invalid`. So a
 * regular file at the expected path opens `ok` here, and only its listing fails.
 */
async function openDiskEntityDirectory(root: string, relDir: string): Promise<EntityDirectoryOpen> {
  const canonicalRoot = await safeRealpath(root);
  if (!canonicalRoot) return { status: "invalid" };
  const expectedDir = path.join(canonicalRoot, relDir);
  try {
    await locationKindNoFollow(expectedDir);
  } catch {
    return { status: "missing" };
  }
  const realDir = await safeRealpath(expectedDir);
  if (realDir !== expectedDir) return { status: "invalid" };
  return { status: "ok", directory: diskEntityDirectory(expectedDir) };
}

/**
 * The entity-directory scans of an ordinary local project rooted at `root`.
 * Building the binding does no I/O and no path work; a bad root is reported
 * when a directory is opened, as `invalid`.
 *
 * @param root - Project root directory, as the caller holds it (not canonicalized here).
 */
export function diskLocalEntityScans(root: string): LegacyLocalEntityScans {
  return { openEntityDirectory: (relDir) => openDiskEntityDirectory(root, relDir) };
}
