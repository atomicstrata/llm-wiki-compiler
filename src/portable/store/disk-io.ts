/**
 * @file src/portable/store/disk-io.ts
 * @description The few confined read and write helpers the disk store is built
 * from. Each one reuses an existing safety primitive rather than touching the
 * filesystem directly: handle-bound, no-follow, capped reads; temp-then-rename
 * writes confined to the project root; and durable create-only publication for
 * ledger records, which must survive a crash to mean anything.
 */

import { mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, atomicWriteNoReplaceDurable, AtomicWriteCollisionError } from "../../utils/atomic-write.js";
import { openConfinedLeaf, readConfinedLeafBuffer, readConfirmedBufferOrElse } from "../../utils/confined-read.js";
import { fsyncDirectory } from "../../utils/atomic-write-durability.js";
import { confineUnderRoot } from "../../utils/path-confine.js";
import { PortableRefusal } from "../errors.js";

/** Owner-only mode for ledger records. */
const PRIVATE_FILE_MODE = 0o600;

/** Bytes of one project-relative file, `null` when absent. Refuses anything unreadable or over `maxBytes`. */
export async function readProjectFile(root: string, relative: string, maxBytes: number): Promise<Buffer | null> {
  const expectedDir = path.join(path.resolve(root), path.dirname(relative));
  const leaf = path.join(expectedDir, path.basename(relative));
  const result = await readConfinedLeafBuffer(root, leaf, expectedDir, maxBytes);
  if (result.kind === "absent") return null;
  if (result.kind !== "ok") throw new PortableRefusal("limit_exceeded", `unreadable or over cap: ${relative}`);
  return result.body;
}

/** One file's bytes with the stat fingerprint of the SAME opened handle. */
export interface FileObservation { bytes: Buffer; fingerprint: string }

/**
 * Read one project file and its stat fingerprint `{dev, ino, size, mtimeNs,
 * ctimeNs}` through ONE opened handle, so the fingerprint can never describe a
 * different inode than the bytes. The confined reader re-checks after the read
 * that the handle is still the file at that path and its size is unchanged; a
 * replacement or growth it can detect makes the read unavailable, not stale.
 *
 * @returns `null` when the file is absent.
 * @throws PortableRefusal when the file is unreadable, replaced mid-read, or over `maxBytes`.
 */
export async function observeProjectFile(root: string, relative: string, maxBytes: number): Promise<FileObservation | null> {
  const expectedDir = path.join(path.resolve(root), path.dirname(relative));
  const opened = await openConfinedLeaf(root, path.join(expectedDir, path.basename(relative)), expectedDir);
  if (opened.kind === "absent") return null;
  if (opened.kind !== "confirmed") throw new PortableRefusal("limit_exceeded", `unreadable: ${relative}`);
  // Taken from the handle BEFORE the read; the reader below closes the handle.
  const stat = await opened.handle.stat({ bigint: true }).catch(() => null);
  const read = await readConfirmedBufferOrElse(opened, maxBytes, () => ({ kind: "unavailable" as const }));
  if (stat === null || read.kind !== "ok") {
    throw new PortableRefusal("limit_exceeded", `unreadable, changed while read, or over cap: ${relative}`);
  }
  const fingerprint = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(".");
  return { bytes: read.body, fingerprint };
}

/** A parsed JSON record, `null` when absent. */
export async function readJsonRecord<T>(root: string, relative: string, maxBytes: number): Promise<T | null> {
  const bytes = await readProjectFile(root, relative, maxBytes);
  return bytes === null ? null : JSON.parse(bytes.toString("utf8")) as T;
}

/** Replace a project file through the confined temp-then-rename writer. */
export async function writeProjectFile(root: string, relative: string, bytes: Uint8Array | string): Promise<void> {
  const abs = await confineUnderRoot(relative, root, { mustExist: false });
  await atomicWrite(abs, bytes, { confineRoot: root });
}

/** Remove a project file; an already-absent file is the goal state, not an error. */
export async function removeProjectFile(root: string, relative: string): Promise<void> {
  const abs = await confineUnderRoot(relative, root, { mustExist: false });
  await unlink(abs).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

/**
 * Durably publish a ledger record that must never be replaced.
 *
 * @returns `false` when a record already exists at that path.
 */
export async function createDurableRecord(root: string, relative: string, bytes: Uint8Array | string): Promise<boolean> {
  const abs = await confineUnderRoot(relative, root, { mustExist: false });
  await mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });
  try {
    await atomicWriteNoReplaceDurable(abs, bytes, { confineRoot: root, mode: PRIVATE_FILE_MODE });
    return true;
  } catch (error) {
    if (error instanceof AtomicWriteCollisionError) return false;
    throw error;
  }
}

/** Regular-file names directly inside a project-relative directory; none when it is absent. */
export async function listFileNames(root: string, relativeDir: string): Promise<string[]> {
  const abs = await confineUnderRoot(relativeDir, root, { mustExist: false });
  try {
    const entries = await readdir(abs, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** One directory entry, and whether it is a regular file. */
export interface DirectoryEntry { name: string; regular: boolean }

/**
 * Every entry directly inside a project-relative directory, regular or not,
 * or `null` when the directory is absent: for a directory whose loss must not
 * read as an empty view.
 */
export async function listEntriesIfPresent(root: string, relativeDir: string): Promise<DirectoryEntry[] | null> {
  const abs = await confineUnderRoot(relativeDir, root, { mustExist: false });
  try {
    const entries = await readdir(abs, { withFileTypes: true });
    return entries.map((entry) => ({ name: entry.name, regular: entry.isFile() })).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Every entry directly inside a project-relative directory, regular or not;
 * none when it is absent. For ledgers that must FAIL CLOSED on an entry that
 * is not a regular file, rather than skip it as {@link listFileNames} does.
 */
export async function listEntries(root: string, relativeDir: string): Promise<DirectoryEntry[]> {
  return (await listEntriesIfPresent(root, relativeDir)) ?? [];
}

/**
 * Publish a project file with power-loss durability: the bytes, and every
 * directory entry from its parent up to the project root, are synced before
 * this returns. For the few writes an ordering guarantee depends on.
 */
export async function writeProjectFileDurable(root: string, relative: string, bytes: Uint8Array | string): Promise<void> {
  const abs = await confineUnderRoot(relative, root, { mustExist: false });
  await mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });
  await atomicWrite(abs, bytes, { confineRoot: root, durable: true, strictDurability: true });
}

/** Create a project directory and durably record it and its ancestors up to the project root. */
export async function ensureDurableDirectory(root: string, relativeDir: string): Promise<void> {
  const abs = await confineUnderRoot(relativeDir, root, { mustExist: false });
  await mkdir(abs, { recursive: true, mode: 0o700 });
  const top = path.resolve(root);
  for (let dir = abs; ; dir = path.dirname(dir)) {
    await fsyncDirectory(dir);
    if (dir === top || path.dirname(dir) === dir) return;
  }
}

/** Every regular file under a project-relative directory, as `/`-joined relative names. */
export async function listFilesRecursive(root: string, relativeDir: string): Promise<string[]> {
  const abs = await confineUnderRoot(relativeDir, root, { mustExist: false });
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isFile()) found.push(entry.name);
    if (!entry.isDirectory()) continue;
    const nested = await listFilesRecursive(root, path.join(relativeDir, entry.name));
    found.push(...nested.map((name) => `${entry.name}/${name}`));
  }
  return found.sort();
}
