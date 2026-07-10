/**
 * Handle-bound confined page read.
 *
 * `readConfinedPage` reads a page file ONLY when it can prove the bytes it
 * returns belong to the exact file at a captured realpath inside a trusted
 * directory. A naive check-then-open is TOCTOU-racy: `O_NOFOLLOW` only guards
 * the FINAL path component, so a PARENT directory swapped between a realpath
 * check and the `open` is silently followed. We defeat that by binding to the
 * OPENED HANDLE: after opening, we `fstat` the handle to capture its
 * `{dev, ino}` identity, then re-resolve and `stat` the expected path and
 * require BOTH that it still sits inside the trusted dir AND that its
 * `{dev, ino}` equals the opened handle's. This binds the OPENED FILE — not the
 * path — so "swap a parent before open, swap it back before the post-check"
 * yields an inode mismatch and fails closed.
 *
 * All read bytes come from the handle (`handle.readFile`); the path is never
 * re-opened. Any mismatch or error returns `null` (fail closed). This is the
 * read-side egress guard complementing the directory/leaf confinement in
 * {@link ../wiki/collect.ts} and {@link ./jsonl-store.ts}.
 */

import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open, stat, realpath, lstat } from "fs/promises";
import path from "path";
import { safeRealpath, isInsideDir } from "./path-confine.js";

/**
 * The discriminated outcome of {@link readCappedNoFollow}, distinguishing the
 * three cases a fail-closed private-leaf read must NOT conflate: a genuinely
 * ABSENT leaf (a clean state, not a fault), an UNAVAILABLE one (a symlinked leaf
 * `ELOOP`, a non-regular file/FIFO, or one over the byte cap — exists-but-
 * untrusted), and an OK regular in-cap leaf with its bytes.
 */
export type CappedLeafRead =
  | { kind: "absent" }
  | { kind: "unavailable" }
  | { kind: "ok"; body: string };

/** An opened, `fstat`-verified regular-file handle within `maxBytes`, or the absent/unavailable outcome that stopped short of one. */
type OpenedCappedHandle = { kind: "absent" } | { kind: "unavailable" } | { kind: "ok"; handle: FileHandle };

/**
 * Open a leaf with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` and `fstat` the HANDLE
 * requiring a REGULAR file within `maxBytes` — the shared open/verify core behind
 * both {@link readCappedNoFollow} (string) and {@link readCappedNoFollowBuffer}
 * (raw bytes), so the two stay ONE implementation rather than a copy-pasted pair.
 * On success the handle is returned STILL OPEN for the caller to read from and
 * close; on `absent`/`unavailable` the handle (if any) is already closed.
 *
 * `O_NONBLOCK` is load-bearing: `O_NOFOLLOW` rejects a symlinked leaf but does NOT
 * stop `open()` from BLOCKING FOREVER on a planted FIFO/named pipe, a local DoS.
 * With `O_NONBLOCK` the open returns immediately and the `isFile()` gate then
 * rejects any non-regular leaf BEFORE any read.
 *
 * @param filePath - The leaf path (under an already-confined private dir).
 * @param maxBytes - The inclusive byte ceiling; a larger leaf is `unavailable`.
 */
async function openCappedNoFollow(filePath: string, maxBytes: number): Promise<OpenedCappedHandle> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ENOENT" ? { kind: "absent" } : { kind: "unavailable" };
  }
  try {
    const st = await handle.stat();
    if (st.isFile() && st.size <= maxBytes) return { kind: "ok", handle };
    await handle.close().catch(() => {});
    return { kind: "unavailable" };
  } catch {
    await handle.close().catch(() => {});
    return { kind: "unavailable" };
  }
}

/**
 * Open a `.llmwiki` private-dir LEAF via {@link openCappedNoFollow} and read its
 * bytes as UTF-8 text — returning a discriminated {@link CappedLeafRead} so the
 * caller can tell ABSENT (`open` ENOENT) apart from UNAVAILABLE (symlinked leaf,
 * non-regular, or oversize). The byte cap is checked on the HANDLE (`fstat`)
 * before reading, so an oversize leaf is never slurped. SHARED by the workflow
 * run store and the local-config reader so the discipline lives once.
 *
 * @param filePath - The leaf path (under an already-confined private dir).
 * @param maxBytes - The inclusive byte ceiling; a larger leaf is `unavailable`.
 * @returns The discriminated read outcome.
 */
export async function readCappedNoFollow(filePath: string, maxBytes: number): Promise<CappedLeafRead> {
  const opened = await openCappedNoFollow(filePath, maxBytes);
  if (opened.kind !== "ok") return opened;
  try {
    return { kind: "ok", body: await opened.handle.readFile("utf-8") };
  } catch {
    return { kind: "unavailable" };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/** The discriminated outcome of {@link readCappedNoFollowBuffer}: the raw-bytes sibling of {@link CappedLeafRead}. */
export type CappedLeafReadBuffer =
  | { kind: "absent" }
  | { kind: "unavailable" }
  | { kind: "ok"; body: Buffer };

/**
 * Open a leaf via {@link openCappedNoFollow} and read its RAW BYTES (no
 * text-decoding) — for callers that must decode strictly themselves (e.g. a
 * fatal `TextDecoder` that must fail closed on invalid UTF-8 rather than let
 * Node's implicit `utf-8` decode silently substitute replacement characters).
 * Same O_NOFOLLOW|O_NONBLOCK open / fstat regular+cap core as
 * {@link readCappedNoFollow}; only the final read differs.
 *
 * @param filePath - The leaf path (under an already-confined private dir).
 * @param maxBytes - The inclusive byte ceiling; a larger leaf is `unavailable`.
 * @returns The discriminated read outcome, carrying a `Buffer` on `ok`.
 */
export async function readCappedNoFollowBuffer(filePath: string, maxBytes: number): Promise<CappedLeafReadBuffer> {
  const opened = await openCappedNoFollow(filePath, maxBytes);
  if (opened.kind !== "ok") return opened;
  try {
    return { kind: "ok", body: await opened.handle.readFile() };
  } catch {
    return { kind: "unavailable" };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/** Test-only seam: fires between open and the {dev,ino} binding check (mirrors {@link readConfinedPageOutcome}). */
export interface ReadLeafOptions { afterOpenForTest?: () => Promise<void>; }

/**
 * Resolve `root`'s realpath and rebuild `expectedDir` under it; null if root is
 * gone. `expectedDir` must be expressed under the LEXICAL `path.resolve(root)`
 * (an in-root join, NOT realpath'd) — this re-anchors its in-root remainder
 * against `realpath(root)` so confinement is invariant to the symlink form root
 * was supplied in (e.g. `/var` vs `/private/var` on macOS). Exported so callers
 * outside this module (e.g. the artifact write-side preflight in `apply.ts`) can
 * root-anchor a directory against the SAME canonical-path discipline the read
 * side uses, rather than duplicating it.
 */
export async function resolveExpectedReal(root: string, expectedDir: string): Promise<string | null> {
  const realRoot = await realpath(root).catch(() => null);
  if (realRoot === null) return null;
  return path.join(realRoot, path.relative(path.resolve(root), expectedDir));
}

/** Classify an `open()` failure as a clean ABSENT (`ENOENT`) vs an UNAVAILABLE fault. */
function classifyLeafOpenError(err: unknown): "absent" | "unavailable" {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT" ? "absent" : "unavailable";
}

/**
 * The two complementary post-open checks — each catches what the other misses:
 *  1. PARENT REALPATH: realpath(dirname(leaf)) must equal the canonical dir built from
 *     the REAL root + literal validated segments. Catches the STATIC escape — a
 *     symlinked parent dir — which the inode check alone misses (lstat only
 *     no-follows the FINAL component; it traverses symlinked parents, so open and
 *     lstat would agree on the same outside file).
 *  2. INODE BINDING: lstat the canonical in-root leaf and require {dev,ino} to match
 *     the opened handle's. Catches the swap-out→open→swap-back RACE, which the parent
 *     check alone misses (the parent looks canonical again by check time).
 * The leaf is never realpath'd (that would follow a symlink).
 */
async function passesPostOpenChecks(leaf: string, expectedReal: string, canonicalLeaf: string, opened: { dev: number; ino: number }): Promise<boolean> {
  const parentReal = await realpath(path.dirname(leaf)).catch(() => null);
  if (parentReal !== expectedReal) return false;
  const canonical = await lstat(canonicalLeaf).catch(() => null);
  return canonical !== null && canonical.dev === opened.dev && canonical.ino === opened.ino;
}

/** A confirmed-in-root, confirmed-regular open handle, or the absent/unavailable outcome that stopped short of one. */
export type ConfinedLeafOpen = { kind: "absent" } | { kind: "unavailable" } | { kind: "confirmed"; handle: FileHandle; size: number };

/** Close `handle` (best-effort) then return `result` — avoids repeating the close-then-return pair at every early-exit branch below. */
async function closeReturning<T>(handle: FileHandle, result: T): Promise<T> {
  await handle.close().catch(() => {});
  return result;
}

/**
 * Open the LITERAL leaf O_NOFOLLOW, `fstat` the HANDLE, and require
 * {@link passesPostOpenChecks} — WITHOUT making any byte-cap decision. This is
 * the shared core behind both {@link readConfinedLeaf} (every root-anchored
 * reader capped to `unavailable`) and the artifact store's `readArtifactBody`
 * (capped to a distinguishable `oversize` outcome): the cap POLICY differs per
 * caller, but the confinement PROOF must not — cap decisions are made only on a
 * `confirmed` (i.e. already-confinement-proven) open. On `confirmed` the handle
 * is STILL OPEN for the caller to read (or not) and close; every other outcome
 * has already closed it. `expectedDir` is a LEXICAL in-root join (see
 * {@link resolveExpectedReal}).
 */
export async function openConfinedLeaf(root: string, leaf: string, expectedDir: string, opts: ReadLeafOptions = {}): Promise<ConfinedLeafOpen> {
  const expectedReal = await resolveExpectedReal(root, expectedDir);
  if (expectedReal === null) return { kind: "unavailable" };
  const canonicalLeaf = path.join(expectedReal, path.basename(leaf));
  let handle: FileHandle;
  try {
    handle = await open(leaf, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    return { kind: classifyLeafOpenError(err) };
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) return await closeReturning(handle, { kind: "unavailable" });
    if (opts.afterOpenForTest) await opts.afterOpenForTest();
    if (!(await passesPostOpenChecks(leaf, expectedReal, canonicalLeaf, opened))) return await closeReturning(handle, { kind: "unavailable" });
    return { kind: "confirmed", handle, size: opened.size };
  } catch {
    return await closeReturning(handle, { kind: "unavailable" });
  }
}

/**
 * Read a CONFIRMED-open leaf's bytes if within `maxBytes`, else invoke
 * `onOversize` with the actual fstat'd size — the one place the two capped
 * readers diverge ({@link readConfinedLeaf} caps oversize to `unavailable`; the
 * artifact body reader caps it to a distinguishable `oversize`). Always closes
 * the handle.
 */
export async function readWithinCapOrElse<T>(opened: Extract<ConfinedLeafOpen, { kind: "confirmed" }>, maxBytes: number, onOversize: (actualBytes: number) => T): Promise<CappedLeafRead | T> {
  try {
    if (opened.size > maxBytes) return onOversize(opened.size);
    return { kind: "ok", body: await opened.handle.readFile("utf-8") };
  } catch {
    return { kind: "unavailable" };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/**
 * ROOT-ANCHORED, HANDLE-BOUND no-follow-leaf read, capping oversize to
 * `unavailable`. Unlike {@link readCappedNoFollow} (which trusts an
 * already-confined private-dir leaf), this re-proves the leaf sits at the
 * canonical path under `realpath(root)` on the OPENED HANDLE — defeating a
 * symlinked PARENT dir (a leaf whose parent resolves outside root) and the
 * swap-out→open→swap-back parent race via the {dev,ino} binding. Used by the
 * artifact manifest reader and the intent-journal pre-state capture, whose
 * targets can be attacker-influenced through their parent directory. See
 * {@link passesPostOpenChecks} for the confinement rationale.
 */
export async function readConfinedLeaf(root: string, leaf: string, expectedDir: string, maxBytes: number, opts: ReadLeafOptions = {}): Promise<CappedLeafRead> {
  const opened = await openConfinedLeaf(root, leaf, expectedDir, opts);
  if (opened.kind !== "confirmed") return opened;
  return readWithinCapOrElse(opened, maxBytes, () => ({ kind: "unavailable" as const }));
}

/** Test-only seam: lets a test interpose between `open` and the post-check. */
export interface ReadConfinedPageOptions {
  /**
   * Invoked AFTER the handle is opened and `fstat`ed but BEFORE the post-open
   * `{dev,ino}` re-check. Tests use it to perform a deterministic filesystem
   * swap so the swap-back race is exercised for real (not mocked away).
   */
  afterOpenForTest?: () => Promise<void>;
}

/**
 * The discriminated outcome of {@link readConfinedPageOutcome}, distinguishing the
 * two cases the null-returning {@link readConfinedPage} conflates: a page that is
 * genuinely UNAVAILABLE as trusted evidence (absent, escaping, symlinked, non-
 * regular, or open-raced — a CLEAN "not there") versus one whose read FAULTED (a
 * raw I/O errno: `EACCES`/`EMFILE`/`ENFILE`/`EIO` — "cannot verify"). A caller
 * that must park-vs-deny on that distinction reads the outcome; one that only
 * needs the bytes keeps using {@link readConfinedPage}.
 */
export type ConfinedPageRead =
  | { kind: "ok"; body: string }
  | { kind: "absent" }
  | { kind: "unreadable"; cause: NodeJS.ErrnoException };

/** Classify an `open()` failure: a clean not-there vs a genuine I/O fault. */
function classifyConfinedError(err: NodeJS.ErrnoException): ConfinedPageRead {
  if (err.code === "ENOENT" || err.code === "ELOOP") return { kind: "absent" };
  return typeof err.code === "string" ? { kind: "unreadable", cause: err } : { kind: "absent" };
}

/**
 * Read a page at `capturedRealpath` as a discriminated {@link ConfinedPageRead},
 * returning `ok` only when the OPENED file is provably the regular file at that
 * realpath inside `expectedCanonicalDir`. A confinement reject (realpath drift,
 * escaping dir, symlinked leaf, non-regular file, inode-swap race) is `absent`; a
 * raw I/O errno (`EACCES`/`EMFILE`/`ENFILE`/`EIO`) is `unreadable`. Opens with
 * `O_NONBLOCK` too, so a planted FIFO leaf cannot BLOCK the open forever (a local
 * DoS `O_NOFOLLOW` alone does not stop) — it returns immediately and the `isFile`
 * gate rejects it.
 *
 * @param capturedRealpath - A realpath captured by the caller's confined scan.
 * @param expectedCanonicalDir - The trusted canonical directory it must stay in.
 * @param opts - Test-only seam (see {@link ReadConfinedPageOptions}).
 */
export async function readConfinedPageOutcome(
  capturedRealpath: string,
  expectedCanonicalDir: string,
  opts: ReadConfinedPageOptions = {},
): Promise<ConfinedPageRead> {
  const precheck = await safeRealpath(capturedRealpath);
  if (precheck !== capturedRealpath || !isInsideDir(capturedRealpath, expectedCanonicalDir)) return { kind: "absent" };
  let handle: FileHandle;
  try {
    handle = await open(capturedRealpath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    return classifyConfinedError(err as NodeJS.ErrnoException);
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) return { kind: "absent" };
    if (opts.afterOpenForTest) await opts.afterOpenForTest();
    if (!(await stillBoundToHandle(capturedRealpath, expectedCanonicalDir, opened))) return { kind: "absent" };
    return { kind: "ok", body: await handle.readFile("utf-8") };
  } catch (err) {
    return classifyConfinedError(err as NodeJS.ErrnoException);
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Read a page at `capturedRealpath`, returning its content only when the OPENED
 * file is provably the regular file at that realpath inside
 * `expectedCanonicalDir`. Returns `null` (fail closed) on any mismatch/error —
 * a thin projection of {@link readConfinedPageOutcome} for callers that do not
 * need to tell a clean absence from a read fault.
 *
 * @param capturedRealpath - A realpath captured by the caller's confined scan.
 * @param expectedCanonicalDir - The trusted canonical directory it must stay in.
 * @param opts - Test-only seam (see {@link ReadConfinedPageOptions}).
 */
export async function readConfinedPage(
  capturedRealpath: string,
  expectedCanonicalDir: string,
  opts: ReadConfinedPageOptions = {},
): Promise<string | null> {
  const read = await readConfinedPageOutcome(capturedRealpath, expectedCanonicalDir, opts);
  return read.kind === "ok" ? read.body : null;
}

/** True when the expected path still resolves inside the dir to the SAME inode. */
async function stillBoundToHandle(
  capturedRealpath: string,
  expectedCanonicalDir: string,
  opened: { dev: bigint | number; ino: bigint | number },
): Promise<boolean> {
  const real = await safeRealpath(capturedRealpath);
  if (real === null || !isInsideDir(real, expectedCanonicalDir)) return false;
  const post = await stat(real);
  return post.dev === opened.dev && post.ino === opened.ino;
}
