/**
 * PID-based lock file for preventing concurrent compilation.
 *
 * Fresh acquisition uses O_CREAT | O_EXCL (the 'wx' flag) for atomic lock
 * creation — the kernel guarantees only one process can create the file.
 *
 * Stale lock reclamation uses a two-lock protocol:
 * 1. Acquire a reclamation lock (.llmwiki/lock.reclaim) via 'wx' to serialize
 *    all processes attempting to reclaim the same stale main lock.
 * 2. Re-verify the main lock is still stale (another reclaimer may have
 *    already fixed it).
 * 3. unlink + tryCreateLock('wx') on the main lock — safe because we hold
 *    exclusive reclamation access.
 * 4. Release the reclamation lock in a finally block.
 *
 * The reclamation lock itself can become stale if a process crashes during
 * the brief reclamation window. When that happens, acquireReclaimLock only
 * cleans up the stale file — it does NOT retry acquisition in the same call.
 * This eliminates the unlink-then-create race that would allow two processes
 * to both hold the reclaim lock. The outer retry loop in acquireLock handles
 * convergence: first pass cleans up the stale reclaim lock, second pass
 * acquires it cleanly via 'wx'.
 */

import { open, unlink } from "fs/promises";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "path";
import { LOCK_FILE, MAX_LOCK_FILE_BYTES } from "./constants.js";
import { resolveConfinedPrivateDir, resolveExistingConfinedPrivateDir } from "./private-dir.js";
import { serializeOwner, parseOwner, isOwnerStale } from "./lock-owner.js";
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

/** Options bounding a {@link acquireLockBlocking} retry loop. */
export interface BlockingLockOptions {
  /** Total time to keep retrying before throwing (ms). */
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
 * Acquire the project lock, RETRYING with a short poll until it succeeds or
 * `timeoutMs` elapses (then throwing {@link LockBusyError}). Unlike the fail-fast
 * {@link acquireLock} (kept for compile), this serializes legitimate concurrent
 * relation writers instead of spuriously failing the loser of a race. Each retry
 * goes through {@link acquireLock}, so stale-lock reclamation still applies.
 *
 * @param root - Absolute project root.
 * @param options - Optional timeout / poll-interval overrides.
 * @throws {LockBusyError} When the lock stays held past `timeoutMs`.
 */
export async function acquireLockBlocking(root: string, options: BlockingLockOptions = {}): Promise<void> {
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
    // Try atomic create — fails if file already exists
    const created = await tryCreateLock(lockPath);
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
 * Atomically create the lock file with our OWNER record (`{pid, startTime}`).
 * Returns true if we created it, false if it already exists. The recorded start
 * time is the PID-reuse-safe liveness identity ({@link isOwnerStale}); a leaf with
 * no start time (legacy build) is read back compatibly.
 */
async function tryCreateLock(lockPath: string): Promise<boolean> {
  // Compute the owner record BEFORE the atomic create so the window between an
  // empty `open(wx)` file and its first bytes stays minimal — a poller that reads
  // the leaf mid-create must never see an EMPTY (→ "stale") file and reclaim a
  // lock another writer is in the middle of taking.
  const ownerRecord = serializeOwner(process.pid);
  try {
    const fd = await open(lockPath, "wx");
    await fd.writeFile(ownerRecord, "utf-8");
    await fd.close();
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw err;
  }
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
    handle = await open(lockPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
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
 * stale. A readable owner is judged by {@link isOwnerStale}: a dead PID is stale
 * (unchanged), AND — closing the PID-reuse wedge — a LIVE PID whose recorded start
 * time differs from the live process's current start time is ALSO stale. A legacy
 * leaf (bare PID, no start time) keeps the PID-only behavior. The reclaim flow is
 * unchanged — it still keys off this boolean.
 */
async function isLockStale(lockPath: string): Promise<boolean> {
  const owner = await readLockOwner(lockPath);
  if (owner === null) return true;
  return isOwnerStale(owner);
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
  let privateDir: string | null;
  try {
    privateDir = await resolveExistingConfinedPrivateDir(root);
  } catch {
    // `.llmwiki` (or an ancestor) escapes the root — refuse to follow it.
    return;
  }
  if (privateDir === null) return; // .llmwiki absent → nothing to release
  const lockPath = lockFileIn(privateDir);
  const owner = await readLockOwner(lockPath);
  if (owner?.pid !== process.pid) return; // foreign / unreadable / symlinked / absent → no-op
  try {
    await unlink(lockPath);
  } catch {
    // Lock already removed or never existed
  }
}
