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
 *
 * STORAGE AND HOST. {@link acquireLockFrom}, {@link acquireLockBlockingFrom} and
 * {@link releaseLockFrom} are THE ONE BODIES, over two separate capabilities they
 * are handed and thread through every private helper: {@link LockIo}, the RAW
 * physical file operations (the private-dir probes, the publication I/O, the
 * root realpath and the capped owner read), and {@link LockHost}, the
 * process-local concerns that are NOT storage (this process's id, the owner
 * record's process identity, process liveness, the clock and sleep, scratch
 * entropy, the process-local FIFO and its parked permits, and diagnostics). The
 * bodies keep every decision: the lock path, the reclaim name, the two attempts,
 * `null` owner means stale, the reclaim protocol, the PID-only release guard,
 * the queue key fallback, every catch, every warning and its order. The root
 * forms keep their signatures and pass {@link diskLockIo} and
 * {@link localLockHost}, whose members call the incumbent functions at call time,
 * so module spies and mocks still intercept them.
 */

import path from "path";
import { locationRealPath } from "../storage/disk-locations.js";
import { readPrivateLeafText } from "../storage/disk-private-leaves.js";
import type { CappedLeafRead } from "./confined-read.js";
import { LOCK_FILE, MAX_LOCK_FILE_BYTES } from "./constants.js";
import {
  diskPrivateDirIo, resolveConfinedPrivateDirFrom, resolveExistingConfinedPrivateDirFrom, type PrivateDirIo,
} from "./private-dir.js";
import { serializeOwner, parseOwner, isLockRecordStale, type LockOwner } from "./lock-owner.js";
import {
  diskLockPublicationIo, hostScratchEntropy, publishLockRecordFrom,
  type LockPublicationHooks, type LockPublicationIo, type ScratchEntropy,
} from "./lock-publication.js";
import { acquireKeyedFifo } from "./keyed-fifo.js";
import * as output from "./output.js";

/**
 * The RAW physical I/O the project lock asks for: the private-dir probes, the
 * publication I/O (whose `removeLeaf` also unlinks the lock and the reclaim
 * lock), and two more members. Each gives a physical answer only and decides
 * nothing; none is hosted, access-controlled, durable or in any package index.
 */
export interface LockIo extends PrivateDirIo, LockPublicationIo {
  /** `location` with every link resolved. REJECTS raw. Disk: `locationRealPath(location)`. */
  realPath(location: string): Promise<string>;
  /**
   * The hardened no-follow, regular-file-only, `maxBytes`-capped text read;
   * `absent` (open `ENOENT`) and `unavailable` (every other refusal or failure)
   * are values and it never rejects. Disk: `readPrivateLeafText(leaf, maxBytes)`.
   */
  readLeafCapped(leaf: string, maxBytes: number): Promise<CappedLeafRead>;
}

/** LOCAL DISK. The incumbent primitives, called at call time; no state, frozen. In no package index. */
const diskLockIo: LockIo = Object.freeze({
  ...diskPrivateDirIo,
  ...diskLockPublicationIo,
  realPath: (location: string) => locationRealPath(location),
  readLeafCapped: (leaf: string, maxBytes: number) => readPrivateLeafText(leaf, maxBytes),
});

/**
 * The HOST concerns the lock asks for, separate from storage. None reads or
 * writes the lock's files; each is a property of THIS process or machine.
 */
export interface LockHost {
  /** This process's id, read at call time. Local: `process.pid`. */
  processId(): number;
  /** The COMPLETE owner record naming `pid`, with its process identity. Local: `serializeOwner(pid)`. */
  serializeOwner(pid: number): string;
  /** Whether a PARSED owner's process is positively gone or reused. Local: `isLockRecordStale(owner)`. */
  isOwnerProcessStale(owner: LockOwner): boolean;
  /** Fresh scratch-name entropy for publication. Local: `hostScratchEntropy`. */
  entropy: ScratchEntropy;
  /** Milliseconds since the epoch. Local: `Date.now()`. */
  now(): number;
  /** Resolve after `ms` milliseconds. Local: a `setTimeout` promise. */
  sleep(ms: number): Promise<void>;
  /** Process-local FIFO admission for `key`. Local: `acquireKeyedFifo`. */
  admit(key: string, timeoutMs: number, timeoutError: () => Error): Promise<() => void>;
  /** Hold a granted queue permit for `key` until {@link LockHost.releaseParked}. Local: the process's permit map. */
  park(key: string, release: () => void): void;
  /** Release and forget the permit parked for `key`, if any. Local: the process's permit map. */
  releaseParked(key: string): void;
  /** Emit one status line. Local: `output.status(icon, message)`. */
  status(icon: string, message: string): void;
}

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

/** Resolve after `ms` milliseconds (the poll backoff between acquire retries). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** LOCAL HOST. The incumbent functions and this process's permit map, called at call time; frozen. In no package index. */
const localLockHost: LockHost = Object.freeze({
  processId: () => process.pid,
  serializeOwner: (pid: number) => serializeOwner(pid),
  isOwnerProcessStale: (owner: LockOwner) => isLockRecordStale(owner),
  entropy: (bytes: number) => hostScratchEntropy(bytes),
  now: () => Date.now(),
  sleep: (ms: number) => delay(ms),
  admit: (key: string, timeoutMs: number, timeoutError: () => Error) => acquireKeyedFifo(key, timeoutMs, timeoutError),
  park: (key: string, release: () => void) => { blockingQueueReleases.set(key, release); },
  releaseParked: (key: string) => {
    blockingQueueReleases.get(key)?.();
    blockingQueueReleases.delete(key);
  },
  status: (icon: string, message: string) => output.status(icon, message),
});

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

/** The process-local queue key: the root's realpath, or its resolved spelling when that fails. */
function lockQueueKey(io: LockIo, root: string): Promise<string> {
  return io.realPath(root).catch(() => path.resolve(root));
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
  return acquireLockBlockingFrom(diskLockIo, localLockHost, root, options);
}

/** THE ONE BODY of {@link acquireLockBlocking}, over the raw I/O and the host it is handed. */
export async function acquireLockBlockingFrom(
  io: LockIo, host: LockHost, root: string, options: BlockingLockOptions = {},
): Promise<void> {
  const queueKey = await lockQueueKey(io, root);
  const timeoutMs = options.timeoutMs ?? DEFAULT_BLOCKING_TIMEOUT_MS;
  const releaseQueue = await host.admit(queueKey, timeoutMs, () => new LockBusyError(timeoutMs));
  try {
    await pollForLock(io, host, root, options);
    host.park(queueKey, releaseQueue);
  } catch (error) {
    releaseQueue();
    throw error;
  }
}

/** Poll for the filesystem lock after this process's same-root waiters take their turn. */
async function pollForLock(io: LockIo, host: LockHost, root: string, options: BlockingLockOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_BLOCKING_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_BLOCKING_INTERVAL_MS;
  const deadline = host.now() + timeoutMs;
  for (;;) {
    // Intermediate retries acquire QUIETLY: a held lock is the EXPECTED steady
    // state while we poll, so the per-attempt "Another compilation is running."
    // warning would spam SDK/MCP callers that retry by design. The final
    // LockBusyError is the clear signal on timeout.
    if (await acquireLockFrom(io, host, root, { quiet: true })) return;
    if (host.now() >= deadline) throw new LockBusyError(timeoutMs);
    await host.sleep(intervalMs);
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
  return acquireLockFrom(diskLockIo, localLockHost, root, options);
}

/** THE ONE BODY of {@link acquireLock}, over the raw I/O and the host it is handed. */
export async function acquireLockFrom(
  io: LockIo, host: LockHost, root: string, options: AcquireLockOptions = {},
): Promise<boolean> {
  // FAIL CLOSED on a `.llmwiki` (or ancestor) that symlinks outside the root:
  // resolving + creating the confined private dir throws on escape, so the lock
  // file is NEVER created out-of-tree (the lock writer runs FIRST in the page
  // mutation path, before the journal). A normal real `.llmwiki` resolves to
  // itself, leaving the happy path byte-identical.
  let privateDir: string;
  try {
    privateDir = await resolveConfinedPrivateDirFrom(io, root);
  } catch {
    if (!options.quiet) host.status("!", output.warn("Lock directory escapes project root — refusing to lock."));
    return false;
  }
  const lockPath = lockFileIn(privateDir);

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    const outcome = await attemptAcquire(io, host, lockPath, options.hooks);
    if (outcome === "acquired") return true;
    if (outcome === "busy") {
      if (!options.quiet) host.status("!", output.warn("Another compilation is running."));
      return false;
    }
  }

  if (!options.quiet) host.status("!", output.warn("Could not acquire lock after retrying."));
  return false;
}

/**
 * One acquisition attempt: publish, else classify the holder and reclaim a
 * stale lock. `retry` means the name was freed under us, or reclamation only
 * cleaned up a stale reclaim lock.
 */
async function attemptAcquire(
  io: LockIo, host: LockHost, lockPath: string, hooks?: LockPublicationHooks,
): Promise<"acquired" | "busy" | "retry"> {
  if (await tryCreateLock(io, host, lockPath, hooks)) return "acquired";

  // The name was taken. If it is gone again, its holder released between the
  // publish and this read: retry publication rather than reclaim a free name.
  const holder = await lockHolderState(io, host, lockPath);
  if (holder === "absent") return "retry";
  if (holder === "live") return "busy";

  // Stale lock — serialize reclamation via a second lock.
  return (await reclaimStaleLock(io, host, lockPath)) ? "acquired" : "retry";
}

/**
 * Reclaim a stale main lock using a serialized two-lock protocol.
 *
 * Acquires .llmwiki/lock.reclaim (via 'wx') so that only one process performs
 * the unlink + recreate sequence at a time. Re-verifies staleness under
 * the reclamation lock in case another process already fixed it.
 * @param lockPath - Absolute path to the main lock file.
 */
async function reclaimStaleLock(io: LockIo, host: LockHost, lockPath: string): Promise<boolean> {
  const reclaimPath = lockPath + RECLAIM_SUFFIX;

  const gotReclaimLock = await acquireReclaimLock(io, host, reclaimPath);
  if (!gotReclaimLock) return false;

  try {
    // Re-verify under exclusive reclamation access. Another reclaimer may have
    // already fixed the main lock — and an ABSENT lock must never be unlinked:
    // the reclaim lock does not stop a fresh acquirer publishing onto a free
    // name, so the unlink below would delete that live holder's record.
    if ((await lockHolderState(io, host, lockPath)) !== "stale") {
      return false;
    }

    // Still stale. Safe to reclaim — we're the only reclaimer.
    try { await io.removeLeaf(lockPath); } catch { /* already gone */ }

    const acquired = await tryCreateLock(io, host, lockPath);
    if (acquired) {
      host.status("i", output.dim("Reclaimed stale lock from dead process."));
    }
    return acquired;
  } finally {
    try { await io.removeLeaf(reclaimPath); } catch { /* cleanup best-effort */ }
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
async function acquireReclaimLock(io: LockIo, host: LockHost, reclaimPath: string): Promise<boolean> {
  if (await tryCreateLock(io, host, reclaimPath)) return true;

  // Reclaim lock exists. Back off unless a present record is stale: an absent
  // one was just released and may already be republished by another reclaimer.
  if ((await lockHolderState(io, host, reclaimPath)) !== "stale") return false;

  // Stale reclaim lock — clean it up but do NOT retry in this call.
  // Retrying here would reintroduce the unlink+create race.
  try { await io.removeLeaf(reclaimPath); } catch { /* already gone */ }
  return false;
}

/**
 * Publish the lock file carrying our OWNER record (`{pid, startTime}`).
 * Returns true if we published it, false if the name was already taken. The
 * recorded start time is the PID-reuse-safe liveness identity ({@link isLockRecordStale});
 * a leaf with no start time (legacy build) is read back compatibly.
 *
 * The record is linked into place COMPLETE — see {@link publishLockRecordFrom}. The
 * previous create-then-write left the authoritative name briefly zero-length,
 * and an empty leaf is precisely what {@link lockHolderState} reports as stale, so a
 * contender could reclaim a lock from a process that was still taking it and
 * both would proceed. Shrinking that window was not enough; publication removes
 * it. The same rule serves the reclaim lock, which acquires through this
 * function too and is read by the identical staleness predicate. Publication
 * runs over the SAME raw I/O and the host's entropy, never a root binding.
 */
async function tryCreateLock(io: LockIo, host: LockHost, lockPath: string, hooks?: LockPublicationHooks): Promise<boolean> {
  return publishLockRecordFrom(io, host.entropy, lockPath, host.serializeOwner(host.processId()), hooks);
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
 * legacy bare PID). {@link releaseLock}'s ownership guard; {@link lockHolderState}
 * makes the same capped read but keeps ABSENT apart from unreadable.
 */
async function readLockOwner(io: LockIo, lockPath: string): Promise<ReturnType<typeof parseOwner>> {
  // Absent (ENOENT), a symlinked leaf, a non-regular leaf, an oversize leaf and a
  // failed stat or read are ALL "no readable owner": this reader has never told
  // absent from unreadable, so both of the storage read's refusals map to null.
  const read = await io.readLeafCapped(lockPath, MAX_LOCK_FILE_BYTES);
  return read.kind === "ok" ? parseOwnerOrNull(read.body) : null;
}

/** Parse an owner record, or `null` when the text is not one. */
function parseOwnerOrNull(body: string): LockOwner | null {
  try {
    return parseOwner(body);
  } catch {
    return null;
  }
}

/** Who holds a lock name right now: nobody, a live owner, or a stale record. */
type LockHolderState = "absent" | "live" | "stale";

/**
 * Classify the holder of an existing lock leaf.
 *
 * ABSENT is its own answer, never "stale". A lock that vanished between a failed
 * publish and this read was RELEASED, and a free name can be published by any
 * contender at any moment without the reclaim lock. Treating it as stale sent
 * the reclaimer on to unlink whatever was at the name by then — a fresh, live
 * holder's record — and republish its own, so two processes held the lock.
 *
 * A present leaf whose owner cannot be read (symlinked / oversize / non-regular /
 * unparseable) is stale, or a corrupt lock would strand the project. A readable
 * owner is judged by the host's liveness classifier ({@link isLockRecordStale}
 * locally): a dead PID, or a live PID whose recorded start time differs from the
 * live process's (PID reuse), is stale. A legacy bare-PID leaf keeps PID-only
 * behavior.
 */
async function lockHolderState(io: LockIo, host: LockHost, lockPath: string): Promise<LockHolderState> {
  const read = await io.readLeafCapped(lockPath, MAX_LOCK_FILE_BYTES);
  if (read.kind === "absent") return "absent";
  const owner = read.kind === "ok" ? parseOwnerOrNull(read.body) : null;
  if (owner === null) return "stale";
  return host.isOwnerProcessStale(owner) ? "stale" : "live";
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
  return releaseLockFrom(diskLockIo, localLockHost, root);
}

/** THE ONE BODY of {@link releaseLock}, over the raw I/O and the host it is handed. Releases the parked queue permit on EVERY exit. */
export async function releaseLockFrom(io: LockIo, host: LockHost, root: string): Promise<void> {
  const queueKey = await lockQueueKey(io, root);
  const releaseQueue = (): void => host.releaseParked(queueKey);
  let privateDir: string | null;
  try {
    privateDir = await resolveExistingConfinedPrivateDirFrom(io, root);
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
  const owner = await readLockOwner(io, lockPath);
  if (owner?.pid !== host.processId()) {
    releaseQueue();
    return; // foreign / unreadable / symlinked / absent → no-op
  }
  try {
    await io.removeLeaf(lockPath);
  } catch {
    // Lock already removed or never existed
  } finally {
    releaseQueue();
  }
}
