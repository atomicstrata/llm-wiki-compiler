/**
 * @file src/storage/disk-locations.ts
 * @description Eleven operations on a location a local caller names. Two are
 * SYNCHRONOUS probes: is anything there, and is what is there something other
 * than a directory. Six are ASYNCHRONOUS reads: the location's real path,
 * whether it is a regular file, its raw following `stat`, its whole text, the
 * whole text of a regular file only (opened without blocking), and a bounded
 * leading prefix of its bytes. THREE WRITE: one appends text, one creates a new file and
 * refuses an existing name, one overwrites. Each is a Node call, or the few
 * calls, its caller used to make inline, moved here unchanged.
 *
 * This is a LOCAL PHYSICAL IMPLEMENTATION BOUNDARY, like the other `disk-*`
 * files: one implementation, nothing injected, no port. Links in the PARENT
 * directories of a location are followed by every function. A link AT the
 * location itself is followed by every function but one: the probes and reads
 * follow it, which is the point of them (a project root that is a link to a
 * directory is a valid root, and a source that is a link to a file is read),
 * and the append and the overwrite write through it; the exclusive create
 * alone does not, because it refuses any existing final entry, a link
 * included. Those are facts about a path on this host. A registered or hosted
 * project uses `ProjectStore`, which makes no such promise and must not be
 * given one.
 *
 * NO FUNCTION HERE GUARDS ANYTHING. The location is used exactly as the caller
 * passes it, relative (resolved by the operating system against the working
 * directory) or absolute. Nothing is confined, no root is checked, and links
 * are treated as the paragraph above says. Every answer is a snapshot: the
 * location can change straight after it is given. Any confinement, any fallback and
 * any decision about what an error means stays with the caller.
 *
 * THE WRITES ARE PLAIN NODE WRITES AND NOTHING MORE. None is atomic, locked
 * or synced, and none checks a parent or a root.
 *  - {@link appendLocationText} follows a link at the location and writes
 *    through it, and creates the file when it is missing. Two appenders can
 *    interleave, and a crash can leave part of the text. It is for the
 *    activity log, which was written exactly this way before.
 *  - {@link createLocationTextExclusive} is the only one that refuses an
 *    existing name, a link included: it never writes through anything that is
 *    already there. A crash can still leave a partly written new file.
 *  - {@link overwriteLocationText} FOLLOWS a link at the location and writes
 *    through it, truncating what is there. It is NOT a safe writer: a reader
 *    can see a half-written file, and only the caller's own check, made
 *    earlier and by path, stands between it and a link. The source writer
 *    updated an existing source exactly this way before.
 *
 * The two probes are synchronous because their callers are: the SDK
 * constructor cannot await. Six of the asynchronous functions (the real
 * path, the raw following `stat`, the whole-text read and the three writes)
 * return Node's own promise
 * WITHOUT an `async` wrapper, so a caller sees the same value or
 * the same rejection on the same tick as when it made the call inline; the
 * project lock computes its queue key from one of them.
 */

import { constants as fsConstants, existsSync, statSync, type Stats } from "node:fs";
import { appendFile, open, readFile, realpath, stat, writeFile } from "node:fs/promises";

/**
 * NO GUARD. `existsSync(location)`, with the location exactly as given. Links
 * are followed, so this is `true` for anything the path resolves to (a
 * directory, a file, a link to either) and `false` for nothing there and for a
 * dangling link. Node's `existsSync` also answers `false` when the lookup
 * itself fails on the filesystem, such as a permission error on a parent, so
 * that case is indistinguishable from absence. Nothing is added here: this
 * function validates no argument and catches nothing, so whatever `existsSync`
 * does with a value it does not accept is what this does.
 */
export function locationExistsSync(location: string): boolean {
  return existsSync(location);
}

/**
 * NO GUARD. `existsSync(location) && !statSync(location).isDirectory()`, in
 * that order, and `statSync` runs only when the first call was `true`. The
 * FINAL link is followed: a link to a directory is not a non-directory, and a
 * link to a file is. `false` for nothing there and for a dangling link.
 *
 * The two calls are separate, so if the location stops resolving between
 * them, `statSync` THROWS its own error, unchanged. That is the behaviour the
 * inline expression had and it is kept, not handled.
 */
export function locationIsNonDirectorySync(location: string): boolean {
  return existsSync(location) && !statSync(location).isDirectory();
}

/**
 * NO GUARD. `realpath(location)`: the location with every link resolved.
 * Returns Node's promise itself, not a wrapped one, so nothing about timing
 * changes for a caller. REJECTS with the raw error when the location does not
 * resolve; the caller chooses any fallback.
 */
export function locationRealPath(location: string): Promise<string> {
  return realpath(location);
}

/**
 * NO GUARD. Whether the location is a regular file, by a FOLLOWING `stat`: a
 * link to a file is a file, and a directory or a link to one is not. REJECTS
 * with the raw error, a dangling link and a missing parent included; the
 * caller decides which errors mean absent.
 */
export async function locationIsRegularFile(location: string): Promise<boolean> {
  return (await stat(location)).isFile();
}

/**
 * NO GUARD. `stat(location)`: Node's own `Stats` for whatever the location
 * resolves to, so a link at the location is FOLLOWED. Returns Node's promise
 * itself, not a wrapped one. REJECTS with the raw error; the caller decides
 * what a failure means and which field it wants.
 *
 * This is strictly a LOCAL PHYSICAL-DISK primitive. It is not a
 * `ProjectStore`, public or hosted contract, and no future port is required
 * to return a `Stats` object.
 */
export function locationStat(location: string): Promise<Stats> {
  return stat(location);
}

/**
 * NO GUARD. `readFile(location, "utf-8")`: the whole content, links followed,
 * decoded as UTF-8 with Node's replacement of invalid sequences. Returns
 * Node's promise itself. REJECTS with the raw error, for a directory too.
 */
export function readLocationText(location: string): Promise<string> {
  return readFile(location, "utf-8");
}

/** Thrown by {@link readRegularLocationText} for a location that is not a regular file (a named pipe, directory or device). */
export class NotRegularFileError extends Error {
  constructor(filePath: string) {
    super(`Not a regular file: ${filePath}`);
    this.name = "NotRegularFileError";
  }
}

/**
 * NO GUARD. The whole UTF-8 text of the location, but only when it is a
 * regular file. It is opened NON-BLOCKING and checked on the open handle
 * before any read: opening a named pipe for reading otherwise waits forever
 * for a writer, which would hang whichever command or viewer refresh was
 * hashing sources. Links are followed. REJECTS with {@link NotRegularFileError}
 * for a named pipe, directory or device, and with the raw error otherwise
 * (`ENOENT` for nothing there).
 */
export async function readRegularLocationText(location: string): Promise<string> {
  const handle = await open(location, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new NotRegularFileError(location);
    return await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
}

/**
 * NO GUARD. The leading bytes of the file at `location`, at most `maxBytes`,
 * by exactly three calls: `open(location, "r")`, ONE `read` into a buffer of
 * `maxBytes` at offset 0, and `close`. A link at the location is FOLLOWED and
 * nothing is confined; a caller that needs the file to be inside a directory
 * must have resolved and checked it already.
 *
 * There is NO LOOP and no retry: the result is exactly the bytes that one
 * `read` returned, so a short read is returned as it is and is NOT topped up.
 * A result shorter than `maxBytes` therefore usually, but not provably, means
 * the whole file was read; what that means is the caller's decision, as is
 * the decoding.
 *
 * `close` runs in `finally` with no `catch`: a failing `close` REJECTS, even
 * after a good read. The open and the read reject with their raw errors too
 * (`ENOENT`, `EISDIR` on the read of a directory, and so on).
 */
export async function readLocationPrefix(location: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(location, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * NO GUARD, AND IT WRITES. `appendFile(location, text, "utf-8")`: the text is
 * added at the end, and the file is created when nothing is there. A link at
 * the location is FOLLOWED and written through. Not atomic, not locked, not
 * made durable. Returns Node's promise itself. REJECTS with the raw error, for
 * a missing parent directory and for a directory at the location too; the
 * caller decides whether a failure matters.
 */
export function appendLocationText(location: string, text: string): Promise<void> {
  return appendFile(location, text, "utf-8");
}

/**
 * NO GUARD, AND IT WRITES, BUT NEVER OVER ANYTHING.
 * `writeFile(location, text, { encoding: "utf-8", flag: "wx" })`: the file is
 * created and written only when nothing has that name. An existing entry of
 * any kind, a link or a dangling link included, REJECTS with `EEXIST` and is
 * not opened or followed. Parent directories are followed and not checked.
 * Not atomic and not made durable: a failure after the create can leave a
 * partly written file. Returns Node's promise itself. REJECTS with the raw
 * error; the caller decides what `EEXIST` means.
 */
export function createLocationTextExclusive(location: string, text: string): Promise<void> {
  return writeFile(location, text, { encoding: "utf-8", flag: "wx" });
}

/**
 * NO GUARD, AND IT OVERWRITES. `writeFile(location, text, "utf-8")`: whatever
 * is at the location is truncated and replaced, and the file is created when
 * nothing is there. A link at the location is FOLLOWED and written through.
 * NOT ATOMIC: a reader can see the file empty or half written, and a crash
 * can leave it so. Not locked, not made durable. Returns Node's promise
 * itself. REJECTS with the raw error. A caller that must not write through a
 * link has to check first, and that check is by path, not by handle.
 */
export function overwriteLocationText(location: string, text: string): Promise<void> {
  return writeFile(location, text, "utf-8");
}
