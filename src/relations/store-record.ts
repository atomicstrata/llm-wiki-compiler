/**
 * @file src/relations/store-record.ts
 * @description Shared record (de)serialization for the relation store: the
 * per-record checksum, the header line, and the graph-directory confinement
 * helper. Kept separate so the append (write) and read paths compute the
 * checksum and resolve the directory through ONE definition — a write and a
 * read can never disagree on what a valid line is.
 *
 * The checksum is a SHA-256 over the RFC 8785 canonicalization of the record's
 * content fields (the {@link RelationRef}, i.e. everything except `checksum`),
 * recomputed on read and compared. It detects a flipped byte anywhere in the
 * line independently of the content hash (which a writer could, in principle,
 * have written wrong).
 *
 * It also owns the shared NO-FOLLOW open primitive for the canonical store FILE
 * leaf (`openStoreFileRead`/`openStoreFileAppend`). Both the read and the write
 * path route through it, so a symlinked `relations.jsonl` leaf can never be
 * followed to read from / append to an out-of-tree file. This is the LEAF
 * defense; {@link resolveGraphDir} is the DIR defense — BOTH are required to
 * confine the store, and routing every open through one primitive means this
 * symlink-escape class cannot reappear at a new call site.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import canonicalize from "canonicalize";
import path from "path";
import { lstat, open } from "fs/promises";
import { WIKI_GRAPH_DIR } from "../utils/constants.js";
import { safeRealpath, isInsideDir, confineUnderRoot } from "../utils/path-confine.js";
import type { RelationRef, RelationRecord, RelationStoreHeader } from "./types.js";
import { RELATION_STORE_SCHEMA_VERSION, RelationStoreSymlinkError } from "./types.js";

/** Default mode for a freshly-created store file (owner rw, group/other r). */
const STORE_FILE_MODE = 0o644;

/** Compute the per-record checksum over a relation's content (excludes `checksum`). */
export function recordChecksum(ref: RelationRef): string {
  const canonical = canonicalize(ref);
  if (canonical === undefined) {
    throw new Error("relation record canonicalization produced no output");
  }
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Serialize a {@link RelationRef} to its on-disk JSONL line (with trailing newline). */
export function serializeRecord(ref: RelationRef): string {
  const record: RelationRecord = { ...ref, checksum: recordChecksum(ref) };
  return JSON.stringify(record) + "\n";
}

/** The header line (with trailing newline) written when a store is created. */
export function headerLine(): string {
  const header: RelationStoreHeader = {
    kind: "relation-store-header",
    schemaVersion: RELATION_STORE_SCHEMA_VERSION,
  };
  return JSON.stringify(header) + "\n";
}

/**
 * Resolve the trusted on-disk graph directory for `root`: `<realpath(root)>/wiki/graph`,
 * requiring it (if it exists) to be a REAL directory at that literal path. A
 * symlinked `wiki/graph` (which would redirect every read/write outside the
 * project) FAILS CLOSED here by throwing. Returns `{ dir, exists }`: `exists`
 * is false when the directory is simply absent (the "no relations" state).
 *
 * Confinement is layered: the shared {@link confineUnderRoot} primitive (with
 * `mustExist:false`) realpath-checks the NEAREST EXISTING ANCESTOR of the graph
 * dir, so even when `wiki/graph` is ABSENT, a symlinked `wiki` (or `root`) that
 * escapes the project fails closed BEFORE any caller `mkdir`s the dir. When the
 * leaf exists, the original lstat/realpath check (a symlinked `wiki/graph`)
 * remains as defense in depth.
 *
 * @param root - Absolute project root.
 * @returns The confined graph dir and whether it currently exists on disk.
 */
export async function resolveGraphDir(root: string): Promise<{ dir: string; exists: boolean }> {
  const canonicalRoot = await safeRealpath(root);
  const base = canonicalRoot ?? path.resolve(root);
  const dir = path.join(base, WIKI_GRAPH_DIR);
  // Confine the NEAREST EXISTING ANCESTOR first: a symlinked `wiki` parent (with
  // `wiki/graph` absent) escaping root throws here, before any caller mkdir.
  await confineUnderRoot(dir, base, { mustExist: false });
  let st;
  try {
    st = await lstat(dir);
  } catch {
    return { dir, exists: false }; // absent → no relations yet
  }
  if (!st.isDirectory()) {
    throw new Error(`relation graph path is not a directory (symlink?): ${WIKI_GRAPH_DIR}`);
  }
  const real = await safeRealpath(dir);
  if (real === null || !isInsideDir(real, base)) {
    throw new Error(`relation graph directory escapes project root: ${WIKI_GRAPH_DIR}`);
  }
  return { dir: real, exists: true };
}

/**
 * Fail closed unless `handle` is a REGULAR file: a FIFO/device/socket at the
 * leaf is rejected just like a symlink, so the store open never lands on a
 * surface a record could be diverted through. Closes the handle before throwing.
 */
async function assertRegularFile(handle: FileHandle): Promise<void> {
  const st = await handle.stat();
  if (!st.isFile()) {
    await handle.close();
    throw new RelationStoreSymlinkError("store file is not a regular file");
  }
}

/**
 * Open the canonical store FILE leaf for READING with `O_NOFOLLOW` — a symlinked
 * leaf fails the open with `ELOOP`, which we fail closed on
 * ({@link RelationStoreSymlinkError}), so a read never follows the link to
 * out-of-tree bytes. An ABSENT file (`ENOENT`) returns `null` (caller treats as
 * empty). After open the HANDLE is `fstat`ed and required to be a regular file.
 * This is the LEAF defense complementing the {@link resolveGraphDir} DIR defense.
 *
 * @param file - The store file path inside the already-confined graph dir.
 * @returns An open read handle, or `null` when the file is absent.
 */
export async function openStoreFileRead(file: string): Promise<FileHandle | null> {
  let handle: FileHandle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null; // absent file → empty store
    if (code === "ELOOP") throw new RelationStoreSymlinkError("store file is a symlink");
    throw err;
  }
  await assertRegularFile(handle);
  return handle;
}

/**
 * Open the canonical store FILE leaf for APPEND with `O_NOFOLLOW` (creating it if
 * absent, mode {@link STORE_FILE_MODE}) — a symlinked leaf fails the open with
 * `ELOOP`, which we fail closed on ({@link RelationStoreSymlinkError}), so the
 * append NEVER lands on an out-of-tree file. After open the HANDLE is `fstat`ed
 * and required to be a regular file. The LEAF defense complementing the
 * {@link resolveGraphDir} DIR defense.
 *
 * @param file - The store file path inside the already-confined graph dir.
 * @returns An open append handle to a confirmed regular file.
 */
export async function openStoreFileAppend(file: string): Promise<FileHandle> {
  const flags = fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW;
  let handle: FileHandle;
  try {
    handle = await open(file, flags, STORE_FILE_MODE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") {
      throw new RelationStoreSymlinkError("store file is a symlink");
    }
    throw err;
  }
  await assertRegularFile(handle);
  return handle;
}
