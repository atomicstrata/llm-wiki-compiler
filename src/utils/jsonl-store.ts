/**
 * @file src/utils/jsonl-store.ts
 * @description Shared confinement + no-follow open primitives for the append-only
 * JSONL stores under `wiki/graph/` (the relation store and the event store). Both
 * stores live in the SAME confined graph directory and both need the identical
 * symlink/regular-file hardening on their leaf file, so that hardening lives here
 * ONCE — five audit rounds went into it, and a second store must inherit it rather
 * than re-derive (and re-mis-derive) it.
 *
 * Two layered defenses, both required to confine a store:
 *  - DIR defense ({@link resolveConfinedGraphDir}): `<realpath(root)>/wiki/graph`
 *    must be a REAL directory at that literal path; a symlinked `wiki/graph` (or a
 *    symlinked `wiki`/`root` ancestor, even when `graph` is absent) FAILS CLOSED.
 *  - LEAF defense ({@link openGraphFileRead}/{@link openGraphFileAppend}): the
 *    store FILE leaf is opened with `O_NOFOLLOW`, so a symlinked leaf fails the
 *    open with `ELOOP` (mapped to the caller's typed symlink error) and the
 *    open then `fstat`s the HANDLE, requiring a REGULAR file.
 *
 * The typed symlink error is INJECTED (`makeSymlinkError`) so each store throws
 * its OWN error class while sharing one open path — a store can never reappear at
 * a new call site without the no-follow leaf defense.
 */

import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open } from "fs/promises";
import path from "path";
import { WIKI_GRAPH_DIR } from "./constants.js";
import { safeRealpath, isInsideDir, confineUnderRoot } from "./path-confine.js";

/** Default mode for a freshly-created store file (owner rw, group/other r). */
const STORE_FILE_MODE = 0o644;

/**
 * Raised when the graph DIR (`wiki/graph`) is a SYMLINK, a non-directory, or
 * escapes the project root — the DIR-defense confinement failure. A SHARED typed
 * error (not a generic `Error`) so BOTH the relation and event surfaces (lint /
 * status / viewer) can CATCH it and map it to a fail-closed finding/problem
 * instead of crashing. FIX F5: a symlinked `wiki/graph` previously threw a generic
 * `Error` that no surface mapped, so it crashed event lint and the profile summary.
 */
export class GraphDirConfinementError extends Error {
  constructor(message: string) {
    super(`graph directory rejected: ${message}`);
    this.name = "GraphDirConfinementError";
  }
}

/** Builds a store-specific typed symlink error from a human-readable reason. */
export type SymlinkErrorFactory = (reason: string) => Error;

/** How a graph store reader opens its leaf and fails closed over the size cap. */
export interface GraphStoreReadConfig {
  /** Basename of the store file inside the confined graph dir (e.g. `events.jsonl`). */
  fileName: string;
  /** The store-typed symlink error factory for the no-follow open. */
  makeSymlinkError: SymlinkErrorFactory;
  /** Maximum store size before the read fails closed (DoS guard). */
  maxBytes: number;
  /** Builds the store-typed over-cap error from the offending byte size. */
  makeOversizeError: (size: number) => Error;
}

/**
 * Read a confined graph store file's raw bytes, or `null` when the dir/file is
 * absent. Resolves the confined graph dir (DIR defense), opens the leaf with
 * `O_NOFOLLOW` (LEAF defense), `fstat`s the HANDLE and FAILS CLOSED above
 * `maxBytes` before the whole-file read (so an attacker/sync-controlled multi-GB
 * file is rejected before it could exhaust memory), then reads the body. The
 * handle is always closed in `finally`. Shared by the relation and event readers
 * so the confinement + size-cap discipline is defined ONCE.
 *
 * @param root - Absolute project root.
 * @param config - The store's leaf name, symlink/oversize errors, and size cap.
 * @returns The raw file body, or `null` when the store is absent.
 */
export async function readConfinedGraphStore(
  root: string,
  config: GraphStoreReadConfig,
): Promise<string | null> {
  const { dir, exists } = await resolveConfinedGraphDir(root); // throws on symlink escape (DIR)
  if (!exists) return null;
  const file = path.join(dir, config.fileName);
  const handle = await openGraphFileRead(file, config.makeSymlinkError); // throws on symlink leaf (LEAF)
  if (handle === null) return null;
  try {
    const size = (await handle.stat()).size;
    if (size > config.maxBytes) throw config.makeOversizeError(size);
    return await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
}

/**
 * Resolve the trusted on-disk graph directory for `root`:
 * `<realpath(root)>/wiki/graph`, requiring it (if it exists) to be a REAL
 * directory at that literal path. A symlinked `wiki/graph` (which would redirect
 * every read/write outside the project) FAILS CLOSED here by throwing the SHARED
 * typed {@link GraphDirConfinementError} (FIX F5: a typed error both store
 * surfaces map, not a generic one that crashes them). Returns `{ dir, exists }`:
 * `exists` is false when the directory is simply absent (the "no records yet" state).
 *
 * Confinement is layered: {@link confineUnderRoot} (with `mustExist:false`)
 * realpath-checks the NEAREST EXISTING ANCESTOR of the graph dir, so even when
 * `wiki/graph` is ABSENT, a symlinked `wiki` (or `root`) escaping the project
 * fails closed BEFORE any caller `mkdir`s the dir. When the leaf exists, the
 * lstat/realpath check (a symlinked `wiki/graph`) remains as defense in depth.
 *
 * @param root - Absolute project root.
 * @returns The confined graph dir and whether it currently exists on disk.
 */
export async function resolveConfinedGraphDir(root: string): Promise<{ dir: string; exists: boolean }> {
  const canonicalRoot = await safeRealpath(root);
  const base = canonicalRoot ?? path.resolve(root);
  const dir = path.join(base, WIKI_GRAPH_DIR);
  // A symlinked `wiki/graph` (or escaping ancestor) makes confineUnderRoot throw a
  // GENERIC escape Error; remap it to the SHARED typed confinement error so both
  // store surfaces can map it to a fail-closed finding/problem rather than crash (FIX F5).
  try {
    await confineUnderRoot(dir, base, { mustExist: false });
  } catch (err) {
    throw new GraphDirConfinementError((err as Error).message);
  }
  let st;
  try {
    st = await lstat(dir);
  } catch {
    return { dir, exists: false }; // absent → no records yet
  }
  if (!st.isDirectory()) {
    throw new GraphDirConfinementError(`graph path is not a directory (symlink?): ${WIKI_GRAPH_DIR}`);
  }
  const real = await safeRealpath(dir);
  if (real === null || !isInsideDir(real, base)) {
    throw new GraphDirConfinementError(`graph directory escapes project root: ${WIKI_GRAPH_DIR}`);
  }
  return { dir: real, exists: true };
}

/**
 * Split a non-empty store body into its post-header RECORD lines, running the
 * caller's `parseHeader` on the first line (which fails closed on an unknown
 * future schema version). Returns `null` for an absent or whitespace-only body so
 * the caller can return its own empty-store shape. Shared by the relation and
 * event readers so the "drop blank lines, validate header, hand back records"
 * preamble is defined ONCE.
 *
 * @param raw - The raw store body, or `null` when the store is absent.
 * @param parseHeader - Validates the header line (throws on a too-new/invalid header).
 * @returns The record lines after the header, or `null` when the store is empty.
 */
export function splitStoreRecords(
  raw: string | null,
  parseHeader: (line: string) => void,
): string[] | null {
  if (raw === null || raw.trim() === "") return null;
  const lines = raw.split("\n").filter((line) => line.length > 0);
  parseHeader(lines[0]);
  return lines.slice(1);
}

/**
 * Fail closed unless `handle` is a REGULAR file: a FIFO/device/socket at the leaf
 * is rejected just like a symlink, so the store open never lands on a surface a
 * record could be diverted through. Closes the handle before throwing.
 */
async function assertRegularFile(handle: FileHandle, makeSymlinkError: SymlinkErrorFactory): Promise<void> {
  const st = await handle.stat();
  if (!st.isFile()) {
    await handle.close();
    throw makeSymlinkError("store file is not a regular file");
  }
}

/**
 * Open a graph store FILE leaf for READING with `O_NOFOLLOW` — a symlinked leaf
 * fails the open with `ELOOP`, mapped to the injected symlink error, so a read
 * never follows the link to out-of-tree bytes. An ABSENT file (`ENOENT`) returns
 * `null` (caller treats as empty). After open the HANDLE is `fstat`ed and
 * required to be a regular file. The LEAF defense complementing the
 * {@link resolveConfinedGraphDir} DIR defense.
 *
 * @param file - The store file path inside the already-confined graph dir.
 * @param makeSymlinkError - Builds the store's typed symlink error.
 * @returns An open read handle, or `null` when the file is absent.
 */
export async function openGraphFileRead(
  file: string,
  makeSymlinkError: SymlinkErrorFactory,
): Promise<FileHandle | null> {
  let handle: FileHandle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null; // absent file → empty store
    if (code === "ELOOP") throw makeSymlinkError("store file is a symlink");
    throw err;
  }
  await assertRegularFile(handle, makeSymlinkError);
  return handle;
}

/**
 * Open a graph store FILE leaf for APPEND with `O_NOFOLLOW` (creating it if
 * absent, mode {@link STORE_FILE_MODE}) — a symlinked leaf fails the open with
 * `ELOOP`, mapped to the injected symlink error, so the append NEVER lands on an
 * out-of-tree file. After open the HANDLE is `fstat`ed and required to be a
 * regular file. The LEAF defense complementing the {@link resolveConfinedGraphDir}
 * DIR defense.
 *
 * @param file - The store file path inside the already-confined graph dir.
 * @param makeSymlinkError - Builds the store's typed symlink error.
 * @returns An open append handle to a confirmed regular file.
 */
export async function openGraphFileAppend(
  file: string,
  makeSymlinkError: SymlinkErrorFactory,
): Promise<FileHandle> {
  const flags = fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW;
  let handle: FileHandle;
  try {
    handle = await open(file, flags, STORE_FILE_MODE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") {
      throw makeSymlinkError("store file is a symlink");
    }
    throw err;
  }
  await assertRegularFile(handle, makeSymlinkError);
  return handle;
}
