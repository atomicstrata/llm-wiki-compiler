/**
 * PID-based lock file for preventing concurrent compilation.
 *
 * Fresh acquisition PUBLISHES the lock create-only: the complete owner record is
 * written to a scratch leaf and linked onto the authoritative name, which the
 * kernel grants to exactly one acquirer. Publication rather than a bare
 * `open(wx)` is what makes the lock atomic in the sense that matters here — the
 * name must never be observable as an EMPTY file, because the staleness
 * predicate treats an unreadable owner as reclaimable and would let a contender
 * take the lock away from a live process mid-acquisition. See
 * {@link ./lock-publication.js}.
 *
 * Stale lock reclamation uses a two-lock protocol:
 * 1. Acquire a reclamation lock (.llmwiki/lock.reclaim) — published under the
 *    same create-only rule — to serialize all processes attempting to reclaim
 *    the same stale main lock.
 * 2. Re-verify the main lock is still stale (another reclaimer may have
 *    already fixed it).
 * 3. unlink + republish the main lock — safe because we hold exclusive
 *    reclamation access.
 * 4. Release the reclamation lock in a finally block.
 *
 * The reclamation lock itself can become stale if a process crashes during
 * the brief reclamation window. When that happens, acquireReclaimLock only
 * cleans up the stale file — it does NOT retry acquisition in the same call.
 * This eliminates the unlink-then-create race that would allow two processes
 * to both hold the reclaim lock. The outer retry loop in acquireLock handles
 * convergence: first pass cleans up the stale reclaim lock, second pass
 * publishes it cleanly.
 */

import { realpath, unlink } from "fs/promises";
import { openFileNoFollow } from "./no-follow-open.js";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "path";
import { LOCK_FILE, MAX_LOCK_FILE_BYTES } from "./constants.js";
import { resolveConfinedPrivateDir, resolveExistingConfinedPrivateDir } from "./private-dir.js";
import { serializeOwner, parseOwner, isLockRecordStale } from "./lock-owner.js";
import { publishLockRecord, type LockPublicationHooks } from "./lock-publication.js";
import { acquireKeyedFifo } from "./keyed-fifo.js";
import * as output from "./output.js";

/**
 * Derive the lock file path inside an already-confined private dir.
 *
 * SINGLE source of the lock-path derivation: both {@link acquireLock} (via the
 * mkdir resolver) and {@link releaseLock} (via the no-mkdir resolver) build the
 * lock path here, so acquire and release can never disagree on it (e.g. on a
 * realpath-divergent root). Joins `path.basename(LOCK_FILE)` under the confined,
 * realpath'd dir — never a raw `path.join(root, LOCK_FILE)` that would follow an
 * escaping `.llmwiki` symlink out of tree.
 */
function lockFileIn(privateDir: string): string {
  return path.join(privateDir, path.basename(LOCK_FILE));
}

const RECLAIM_SUFFIX = ".reclaim";
const MAX_ACQUIRE_ATTEMPTS = 2;

/** Default bound a blocking acquire waits before declaring the store busy. */
const DEFAULT_BLOCKING_TIMEOUT_MS = 5_000;
/** Default poll interval between blocking-acquire retries. */
const DEFAULT_BLOCKING_INTERVAL_MS = 25;

/** Queue permits held by successful blocking acquisitions until releaseLock. */
const blockingQueueReleases = new Map<string, () => void>();

/** Options bounding a {@link acquireLockBlocking} retry loop. */
export interface BlockingLockOptions {
  /** Maximum time without local-queue or filesystem-lock progress before throwing (ms). */
  timeoutMs?: number;
  /** Delay between retries (ms). */
  intervalMs?: number;
}

/** Thrown when a bounded-blocking lock acquire times out without acquiring. */
export class LockBusyError extends Error {
  constructor(timeoutMs: number) {
    super(`relation store busy after ${timeoutMs}ms`);
    this.name = "LockBusyError";
  }
}

/** Resolve after `ms` milliseconds (the poll backoff between acquire retries). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire the project lock through a process-local FIFO, then RETRY with a short
 * poll until it succeeds or `timeoutMs` elapses without progress (then throwing
 * {@link LockBusyError}). The FIFO prevents a same-process burst from starting
 * every filesystem deadline at once; completing each local holder resets the
 * waiting entries' no-progress bound. Cross-process exclusion and stale-lock
 * reclamation remain owned by {@link acquireLock}.
 *
 * @param root - Absolute project root.
 * @param options - Optional timeout / poll-interval overrides.
 * @throws {LockBusyError} When the lock stays held past `timeoutMs`.
 */
export async function acquireLockBlocking(root: string, options: BlockingLockOptions = {}): Promise<void> {
  const queueKey = await realpath(root).catch(() => path.resolve(root));
  const timeoutMs = options.timeoutMs ?? DEFAULT_BLOCKING_TIMEOUT_MS;
  const releaseQueue = await acquireKeyedFifo(queueKey, timeoutMs, () => new LockBusyError(timeoutMs));
  try {
    await pollForLock(root, options);
    blockingQueueReleases.set(queueKey, releaseQueue);
  } catch (error) {
    releaseQueue();
    throw error;
  }
}

/** Poll for the filesystem lock after this process's same-root waiters take their turn. */
async function pollForLock(root: string, options: BlockingLockOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_BLOCKING_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_BLOCKING_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Intermediate retries acquire QUIETLY: a held lock is the EXPECTED steady
    // state while we poll, so the per-attempt "Another compilation is running."
    // warning would spam SDK/MCP callers that retry by design. The final
    // LockBusyError is the clear signal on timeout.
    if (await acquireLock(root, { quiet: true })) return;
    if (Date.now() >= deadline) throw new LockBusyError(timeoutMs);
    await delay(intervalMs);
  }
}

/** Options for {@link acquireLock}. `quiet` suppresses the busy warning. */
export interface AcquireLockOptions {
  /** Suppress the "Another compilation is running." warning on a busy lock. */
  quiet?: boolean;
  /**
   * Publication seams, supplied only by tests. The double-ownership window this
   * lock once had lived entirely inside one acquisition, so a regression test
   * for it must be able to hold that interval open on demand rather than hope
   * to land in it — hoping is what let the defect read as a scheduling flake.
   *
   * Applies to the FRESH acquisition only. Reclamation republishes under the
   * same create-only rule, but its publication is already serialized by the
   * reclaim lock, so it is not the interval a contender can race into.
   */
  hooks?: LockPublicationHooks;
}

/**
 * Acquire the compilation lock. Returns true if acquired, false if busy.
 *
 * Retries up to MAX_ACQUIRE_ATTEMPTS times to handle the case where the
 * first attempt cleans up a stale reclamation lock but cannot acquire it
 * in the same call (to avoid the double-winner race).
 *
 * @param root - Project root directory.
 * @param options - When `quiet`, the busy-lock warning is suppressed (used by
 *   {@link acquireLockBlocking}'s intermediate retries so by-design pollers stay
 *   silent). The fail-fast CLI path leaves it unset and still prints the warning.
 */
export async function acquireLock(root: string, options: AcquireLockOptions = {}): Promise<boolean> {
  // FAIL CLOSED on a `.llmwiki` (or ancestor) that symlinks outside the root:
  // resolving + creating the confined private dir throws on escape, so the lock
  // file is NEVER created out-of-tree (the lock writer runs FIRST in the page
  // mutation path, before the journal). A normal real `.llmwiki` resolves to
  // itself, leaving the happy path byte-identical.
  let privateDir: string;
  try {
    privateDir = await resolveConfinedPrivateDir(root);
  } catch {
    if (!options.quiet) output.status("!", output.warn("Lock directory escapes project root — refusing to lock."));
    return false;
  }
  const lockPath = lockFileIn(privateDir);

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    // Try create-only publication — fails if the name is already taken
    const created = await tryCreateLock(lockPath, options.hooks);
    if (created) return true;

    // Lock exists. Check if the holding process is dead.
    const stale = await isLockStale(lockPath);
    if (!stale) {
      if (!options.quiet) output.status("!", output.warn("Another compilation is running."));
      return false;
    }

    // Stale lock — serialize reclamation via a second lock.
    const reclaimed = await reclaimStaleLock(root, lockPath);
    if (reclaimed) return true;

    // Reclamation failed (e.g. cleaned up stale reclaim lock). Retry.
  }

  if (!options.quiet) output.status("!", output.warn("Could not acquire lock after retrying."));
  return false;
}

/**
 * Reclaim a stale main lock using a serialized two-lock protocol.
 *
 * Acquires .llmwiki/lock.reclaim (via 'wx') so that only one process performs
 * the unlink + recreate sequence at a time. Re-verifies staleness under
 * the reclamation lock in case another process already fixed it.
 * @param root - Project root directory.
 * @param lockPath - Absolute path to the main lock file.
 */
async function reclaimStaleLock(root: string, lockPath: string): Promise<boolean> {
  const reclaimPath = lockPath + RECLAIM_SUFFIX;

  const gotReclaimLock = await acquireReclaimLock(reclaimPath);
  if (!gotReclaimLock) return false;

  try {
    // Re-verify under exclusive reclamation access.
    // Another reclaimer may have already fixed the main lock.
    if (!(await isLockStale(lockPath))) {
      return false;
    }

    // Still stale. Safe to reclaim — we're the only reclaimer.
    try { await unlink(lockPath); } catch { /* already gone */ }

    const acquired = await tryCreateLock(lockPath);
    if (acquired) {
      output.status("i", output.dim("Reclaimed stale lock from dead process."));
    }
    return acquired;
  } finally {
    try { await unlink(reclaimPath); } catch { /* cleanup best-effort */ }
  }
}

/**
 * Acquire the reclamation lock. Uses 'wx' for atomic creation.
 *
 * If the reclaim lock is stale (holder crashed during reclamation), this
 * function ONLY cleans up the stale file and returns false. It does NOT
 * retry acquisition in the same call. This is the key safety property:
 * unlink and create never happen in the same call, so two processes that
 * both see a stale reclaim lock will both clean up (harmless — second
 * unlink gets ENOENT) and both return false. Neither holds the reclaim
 * lock, so neither proceeds to touch the main lock. The outer retry loop
 * in acquireLock converges on the next attempt via a clean 'wx'.
 * @param reclaimPath - Absolute path to the reclamation lock file.
 */
async function acquireReclaimLock(reclaimPath: string): Promise<boolean> {
  if (await tryCreateLock(reclaimPath)) return true;

  // Reclaim lock exists. If its holder is alive, back off.
  if (!(await isLockStale(reclaimPath))) return false;

  // Stale reclaim lock — clean it up but do NOT retry in this call.
  // Retrying here would reintroduce the unlink+create race.
  try { await unlink(reclaimPath); } catch { /* already gone */ }
  return false;
}

/**
 * Publish the lock file carrying our OWNER record (`{pid, startTime}`).
 * Returns true if we published it, false if the name was already taken. The
 * recorded start time is the PID-reuse-safe liveness identity ({@link isLockRecordStale});
 * a leaf with no start time (legacy build) is read back compatibly.
 *
 * The record is linked into place COMPLETE — see {@link publishLockRecord}. The
 * previous create-then-write left the authoritative name briefly zero-length,
 * and an empty leaf is precisely what {@link isLockStale} reports as stale, so a
 * contender could reclaim a lock from a process that was still taking it and
 * both would proceed. Shrinking that window was not enough; publication removes
 * it. The same rule serves the reclaim lock, which acquires through this
 * function too and is read by the identical staleness predicate.
 */
async function tryCreateLock(lockPath: string, hooks?: LockPublicationHooks): Promise<boolean> {
  return publishLockRecord(lockPath, serializeOwner(process.pid), hooks);
}

/**
 * Read the OWNER record from the lock leaf through a HARDENED handle, or `null` on
 * ANY failure (absent / symlinked / oversize / non-regular / unparseable).
 *
 * Opens with `O_RDONLY | O_NOFOLLOW` so a planted symlinked `.llmwiki/lock` →
 * `ELOOP` (never followed to its out-of-tree target — closing the symlink-class
 * read oracle + the unbounded-target DoS), `fstat`s the HANDLE requiring a REGULAR
 * file, and enforces the small {@link MAX_LOCK_FILE_BYTES} cap before reading. The
 * raw text is then parsed by {@link parseOwner} (new `{pid, startTime}` JSON OR a
 * legacy bare PID). The single hardened leaf reader shared by {@link isLockStale}
 * (stale check) and {@link releaseLock} (ownership guard), so neither follows nor
 * over-reads the leaf.
 */
async function readLockOwner(lockPath: string): Promise<ReturnType<typeof parseOwner>> {
  let handle: FileHandle;
  try {
    handle = await openFileNoFollow(lockPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return null; // absent (ENOENT) / symlinked leaf (ELOOP) → no readable owner
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_LOCK_FILE_BYTES) return null;
    return parseOwner(await handle.readFile("utf-8"));
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Check if an existing lock is stale (its holder no longer holds it).
 *
 * The leaf is read through {@link readLockOwner} (no-follow + fstat-capped), so a
 * `null` owner (absent / symlinked / oversize / non-regular / unparseable) is
 * stale. A readable owner is judged by {@link isLockRecordStale}: a dead PID is stale
 * (unchanged), AND — closing the PID-reuse wedge — a LIVE PID whose recorded start
 * time differs from the live process's current start time is ALSO stale. A legacy
 * leaf (bare PID, no start time) keeps the PID-only behavior. The reclaim flow is
 * unchanged — it still keys off this boolean.
 */
async function isLockStale(lockPath: string): Promise<boolean> {
  const owner = await readLockOwner(lockPath);
  if (owner === null) return true;
  return isLockRecordStale(owner);
}

/**
 * Release the compilation lock. Safe to call even if the lock doesn't exist.
 *
 * OWNERSHIP PRECONDITION: only unlinks the lock when WE own it (the leaf's PID ===
 * `process.pid`). A lock owned by a DIFFERENT pid — or one that is unreadable /
 * symlinked / oversize / absent (owner `null`) — is left untouched (a NO-OP), so a
 * stray or cross-actor `releaseLock` can NEVER delete a lock held by another live
 * process and silently drop mutual exclusion.
 *
 * CONFINED the SAME way as {@link acquireLock}: derives the lock path through the
 * no-mkdir read resolver so release NEVER creates `.llmwiki` and NEVER follows an
 * escaping `.llmwiki` (or ancestor) symlink, and the ownership read goes through the
 * no-follow {@link readLockOwnerPid} so a symlinked leaf is never followed to a
 * victim OUTSIDE the root. When the private dir is absent OR escapes the root there
 * is nothing safe to release, so this is a no-op (it must not throw — callers run it
 * in `finally`).
 *
 * RESIDUAL (deferred follow-up, NOT fixed here): the PID guard prevents CROSS-process
 * deletion but not a SAME-process nested-helper mistake — a self-locking helper
 * invoked while this same process already holds the lock would still match its own
 * pid and release it early. Fixing that needs a release-token refactor across all
 * ~14 callers, out of scope for this bundle; the `locked:`-variant convention plus
 * the new ownership tests cover it for now.
 *
 * @param root - Absolute project root.
 */
export async function releaseLock(root: string): Promise<void> {
  const queueKey = await realpath(root).catch(() => path.resolve(root));
  const releaseQueue = (): void => {
    blockingQueueReleases.get(queueKey)?.();
    blockingQueueReleases.delete(queueKey);
  };
  let privateDir: string | null;
  try {
    privateDir = await resolveExistingConfinedPrivateDir(root);
  } catch {
    // `.llmwiki` (or an ancestor) escapes the root — refuse to follow it.
    releaseQueue();
    return;
  }
  if (privateDir === null) {
    releaseQueue();
    return; // .llmwiki absent → nothing to release
  }
  const lockPath = lockFileIn(privateDir);
  const owner = await readLockOwner(lockPath);
  if (owner?.pid !== process.pid) {
    releaseQueue();
    return; // foreign / unreadable / symlinked / absent → no-op
  }
  try {
    await unlink(lockPath);
  } catch {
    // Lock already removed or never existed
  } finally {
    releaseQueue();
  }
}
