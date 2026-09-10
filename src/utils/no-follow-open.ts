/**
 * Leaf-only no-follow opening for reads and append-only stores.
 * Native platforms retain their callers' exact flags. Without O_NOFOLLOW,
 * bind a regular leaf's pre-open identity to its handle and post-open lstat
 * before returning that handle. Missing append targets use exclusive creation;
 * opening must never truncate or write before verification. Parent confinement
 * remains the caller's responsibility. Portable-branch tests are not proof of
 * native Windows filesystem behavior.
 */
import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "fs/promises";
import type { FileHandle } from "node:fs/promises";

/** A leaf-policy rejection, distinct from an ordinary filesystem I/O failure. */
export class NoFollowOpenError extends Error {
  readonly code: string;
  constructor(readonly reason: "symlink" | "not-regular" | "identity") {
    super(`No-follow open refused: ${reason}`);
    this.name = "NoFollowOpenError";
    this.code = reason === "symlink" ? "ELOOP" : "ENOFOLLOW";
  }
}

/** Reject links, special files and volumes without a usable file identity. */
function requireRegular(st: BigIntStats): void {
  if (st.isSymbolicLink()) throw new NoFollowOpenError("symlink");
  if (!st.isFile()) throw new NoFollowOpenError("not-regular");
  if (st.ino === 0n) throw new NoFollowOpenError("identity");
}

/** Compare full-width file ids rather than potentially rounded JS numbers. */
function requireIdentity(left: BigIntStats, right: BigIntStats): void {
  if (left.dev !== right.dev || left.ino !== right.ino) throw new NoFollowOpenError("identity");
}

/** Read a leaf identity without following it; only actual absence permits creation. */
async function inspectLeaf(file: string): Promise<BigIntStats | null> {
  try {
    const st = await lstat(file, { bigint: true });
    requireRegular(st);
    return st;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Verify before returning any readable/writable handle; close on every failure. */
async function bindHandle(file: string, handle: FileHandle, before: BigIntStats | null): Promise<FileHandle> {
  try {
    const opened = await handle.stat({ bigint: true });
    requireRegular(opened);
    if (before !== null) requireIdentity(before, opened);
    const after = await inspectLeaf(file);
    if (after === null) throw new NoFollowOpenError("identity");
    requireIdentity(opened, after);
    return handle;
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
}

/** Bound a portable open, retrying one exclusive-create collision without clobbering. */
async function openPortable(file: string, flags: number, mode: number | undefined, canRetry: boolean): Promise<FileHandle> {
  const before = await inspectLeaf(file);
  const creates = before === null && Boolean(flags & constants.O_CREAT);
  const safeFlags = creates ? flags | constants.O_EXCL : flags & ~(constants.O_CREAT | constants.O_EXCL);
  let handle: FileHandle;
  try {
    handle = await open(file, safeFlags, mode);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (creates && code === "EEXIST" && canRetry) return openPortable(file, flags, mode, false);
    if (before !== null && code === "ENOENT") throw new NoFollowOpenError("identity");
    throw err;
  }
  return bindHandle(file, handle, before);
}

/**
 * Open an internal read/append leaf with the caller's native flags, or a verified
 * portable fallback. The caller owns and closes the returned handle. Unsupported
 * write modes are refused before opening so verification cannot follow damage.
 */
export async function openFileNoFollow(file: string, flags: number, mode?: number): Promise<FileHandle> {
  if (constants.O_NOFOLLOW) return open(file, flags, mode);
  const writes = flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT);
  if ((flags & constants.O_TRUNC) || (flags & constants.O_RDWR) || (writes && !(flags & constants.O_APPEND))) {
    throw new Error("Portable no-follow opening supports only reads and append-only writes");
  }
  return openPortable(file, flags, mode, true);
}
