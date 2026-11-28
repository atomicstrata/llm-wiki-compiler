/**
 * @file src/scale/downgrade-fs.ts
 * @description The file mechanisms of a scale-down, all confined to the
 * project root and none of them recursive:
 *
 * - {@link leafDigest}: one confined, no-follow, single-link open of a regular
 *   file, hashed in bounded chunks (never held whole), with its identity;
 * - {@link identityAt}: the unfollowed identity of whatever is at a path
 *   (device, inode, size, nanosecond mtime, kind), or null when absent;
 * - {@link renameBound}: an IDENTITY-BOUND rename: the source must still be
 *   exactly the expected object, the destination must be absent, both parents
 *   must be their real in-root directories, and both are synced after;
 * - {@link finishMove}: for a move a resume finds ALREADY done, sync both
 *   parents again before relying on it (a kill between a rename and its
 *   directory syncs leaves a move that is visible but not yet durable).
 *
 * Nothing here deletes anything. A changed source or an occupied destination
 * refuses before the rename and leaves both untouched.
 */

import { createHash } from "node:crypto";
import { lstat, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { fsyncConfinedDirectory } from "../utils/confined-delete.js";
import { openConfinedLeaf, resolveExpectedReal } from "../utils/confined-read.js";
import { ensureConfinedDirectory } from "../utils/confined-scaffold.js";

/** Bytes hashed per read. */
const HASH_CHUNK_BYTES = 1024 * 1024;

/** The unfollowed identity of one filesystem object. Numbers are decimal strings (bigint stats). */
export interface ObjectIdentityV1 {
  readonly kind: "file" | "directory" | "other";
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
}

/** A regular file's digest and identity, or why it has none. */
export type LeafDigest = { readonly kind: "absent" } | { readonly kind: "unavailable" } | { readonly kind: "ok"; readonly sha256: string; readonly bytes: number; readonly identity: ObjectIdentityV1 };

/** `relPath` under `root`, joined natively. */
export function at(root: string, relPath: string): string {
  return path.join(root, ...relPath.split("/"));
}

/** The identity of whatever is at `relPath`, unfollowed, or null when absent. */
export async function identityAt(root: string, relPath: string): Promise<ObjectIdentityV1 | null> {
  let stat;
  try { stat = await lstat(at(root, relPath), { bigint: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const kind = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";
  return { kind, dev: stat.dev.toString(), ino: stat.ino.toString(), size: stat.size.toString(), mtimeNs: stat.mtimeNs.toString() };
}

/** Whether two identities name the same object in the same state (a directory's size and mtime may move with its entries). */
export function sameObject(a: ObjectIdentityV1, b: ObjectIdentityV1): boolean {
  const same = a.kind === b.kind && a.dev === b.dev && a.ino === b.ino;
  return a.kind === "directory" ? same : same && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

/** Hash a regular single-link file in bounded chunks, refusing if its length exceeds `maxBytes`. */
export async function leafDigest(root: string, relPath: string, maxBytes = Number.MAX_SAFE_INTEGER): Promise<LeafDigest> {
  const leaf = at(root, relPath);
  const opened = await openConfinedLeaf(root, leaf, path.dirname(leaf), { requireSingleLink: true });
  if (opened.kind !== "confirmed") return opened;
  try {
    const stat = await opened.handle.stat({ bigint: true });
    if (stat.size > BigInt(maxBytes)) return { kind: "unavailable" };
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(HASH_CHUNK_BYTES);
    let bytes = 0;
    for (;;) {
      const length = Math.min(HASH_CHUNK_BYTES, Number(stat.size) - bytes + 1);
      const { bytesRead } = await opened.handle.read(buffer, 0, length, bytes);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (BigInt(bytes) > stat.size) return { kind: "unavailable" };
      hash.update(buffer.subarray(0, bytesRead));
    }
    const identity: ObjectIdentityV1 = { kind: "file", dev: stat.dev.toString(), ino: stat.ino.toString(), size: stat.size.toString(), mtimeNs: stat.mtimeNs.toString() };
    // Re-check after reading: an edit during the read (even of the same size) or a replaced path is not a digest of one file.
    const after = await opened.handle.stat({ bigint: true });
    const atPath = await identityAt(root, relPath);
    const stable = BigInt(bytes) === stat.size && after.size === stat.size && after.mtimeNs === stat.mtimeNs && atPath !== null && sameObject(atPath, identity);
    return stable ? { kind: "ok", sha256: hash.digest("hex"), bytes, identity } : { kind: "unavailable" };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/** Refuse unless the directory at `relDir` is its own real in-root directory (no redirected component). */
async function assertRealDirectory(root: string, relDir: string): Promise<void> {
  const expected = await resolveExpectedReal(root, at(root, relDir));
  const actual = await realpath(at(root, relDir)).catch(() => null);
  if (expected === null || actual !== expected) throw new Error(`${relDir} is not a confined in-root directory`);
}

/** Create the directory `relDir` (and its parents) confined under `root`, syncing its parent when it was created. */
export async function ensureDirectory(root: string, relDir: string): Promise<void> {
  if (await ensureConfinedDirectory(root, relDir)) await fsyncConfinedDirectory(root, at(root, path.posix.dirname(relDir)));
}

/**
 * Rename `fromRel` to `toRel` only while `fromRel` is still exactly `expected`
 * and `toRel` is absent; both parents are checked real and synced after.
 */
export async function renameBound(root: string, fromRel: string, toRel: string, expected: ObjectIdentityV1, afterRename?: () => Promise<void>): Promise<void> {
  const current = await identityAt(root, fromRel);
  if (current === null || !sameObject(current, expected)) throw new Error(`${fromRel} is not the object this scale-down expects; nothing was moved`);
  if ((await identityAt(root, toRel)) !== null) throw new Error(`${toRel} already exists; nothing was moved`);
  const [fromDir, toDir] = [path.posix.dirname(fromRel), path.posix.dirname(toRel)];
  await assertRealDirectory(root, fromDir);
  await assertRealDirectory(root, toDir);
  await rename(at(root, fromRel), at(root, toRel));
  await afterRename?.();
  await finishMove(root, fromRel, toRel);
}

/** Sync both parents of a move from `fromRel` to `toRel` (done, or found done by a resume). */
export async function finishMove(root: string, fromRel: string, toRel: string): Promise<void> {
  const [fromDir, toDir] = [path.posix.dirname(fromRel), path.posix.dirname(toRel)];
  await fsyncConfinedDirectory(root, at(root, fromDir));
  if (toDir !== fromDir) await fsyncConfinedDirectory(root, at(root, toDir));
}
