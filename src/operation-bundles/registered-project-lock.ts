/**
 * @file src/operation-bundles/registered-project-lock.ts
 * @description Brings the few legacy writers that used to take NO project
 * lock under the shared project lock.
 *
 * Source ingest, the SDK's source delete and `schema init` write authoritative
 * project content. They are COOPERATIVE WRITERS: each now takes the project
 * lock before it writes, on every project (`withCooperativeWriterLock`).
 *
 * - On a REGISTERED project (one that carries the portable directory, an
 *   expected-scale record or indexed stores) the write runs inside the GATED
 *   mutation lock, so it serializes with portable publications and with
 *   `scale set` / `scale prepare`, and the gate refuses it, before any effect,
 *   while a publication intent is unresolved or a scale transition is
 *   unfinished, parked or unavailable. A record is never deleted, so once
 *   seen it is always seen.
 * - On an ORDINARY project the write takes the same lock file WITHOUT the
 *   recovery gate, and then looks at the registration AGAIN under the lock. A
 *   transition (which holds that lock for its whole run) can therefore neither
 *   start nor finish while the writer writes. If registration appeared while
 *   the writer waited for the lock, nothing has been written: the writer
 *   releases and starts again under the gated lock, where an unfinished
 *   transition refuses it.
 *
 * WHAT THIS COSTS. An ordinary project's ingest, SDK source delete and
 * `schema init` used to run lock-free. They now wait for the project lock, so
 * one started while a compile (or another holder) is running waits, and after
 * the lock's existing bounded wait refuses with {@link ProjectBusyError}
 * instead of writing beside it. The refusal comes BEFORE the writer runs: no
 * source or schema file was changed, and the caller retries once the other
 * operation has finished. Nothing is queued without bound and nothing is
 * retried silently. They also create `.llmwiki/` if it is absent, to hold the
 * lock, and the project directory itself when a first ingest names a root
 * that does not exist yet (the writer always created it; the lock, taken
 * first, must not report a missing directory as a busy project).
 *
 * ONLY LOCK CONTENTION becomes a `ProjectBusyError`: the lock's own
 * {@link LockBusyError}, kept as the `cause`. A gate refusal (a pending
 * publication or scale transition), a confinement failure, an I/O error and
 * anything the writer itself throws propagate unchanged.
 *
 * WHAT THIS DOES NOT COVER. Only writers that go through this module
 * cooperate. A file written into `sources/` by an editor or another tool
 * takes no lock; that is the existing compatibility boundary. A catalog
 * notices such a change from a directory's recorded stamps when a listing or
 * sync examines it, and the next compile or `catalog sync` reconciles it: that
 * is detection and reconciliation, not a guarantee of immediate notice.
 *
 * `withRegisteredProjectLock` is unchanged: it serves operations that exist
 * only on a registered project (catalog and indexed maintenance) and still
 * runs an unregistered project's operation without a lock.
 *
 * A portable `source.add` never comes through here: it writes through the
 * store under its own gate intent, so there is no re-entry.
 *
 * ONE BODY. {@link withRegisteredProjectLockWith} owns the decision (lock only a
 * registered project, release on every exit) over a
 * {@link RegisteredProjectGate}: the portable-directory look and the blocking
 * lock are its mechanisms. The root form passes the local gate.
 */

import { mkdir } from "node:fs/promises";
import { hasPortableDirectory } from "../portable/host/pending-gate.js";
import { downgradeIntentMayExist } from "../scale/downgrade-admission.js";
import { hasScaleRecord, indexedStoresMayExist } from "../scale/record.js";
import { acquireLockBlocking, LockBusyError, releaseLock } from "../utils/lock.js";
import type { saveSource } from "../utils/source-writer.js";
import { saveSourceRouted } from "../catalog/routes.js";
import { acquireMutationLockBlocking } from "./lock-gate.js";

/** Whether ordinary writes need the gated project lock. */
async function registeredForWrite(root: string): Promise<boolean> {
  return (await hasPortableDirectory(root)) || (await hasScaleRecord(root)) || (await indexedStoresMayExist(root)) || (await downgradeIntentMayExist(root));
}

/**
 * Run a lock-free legacy writer, under the gated project lock when (and only
 * when) the project carries the portable directory or an expected-scale record.
 *
 * @param root - Project root directory.
 * @param write - The writer, unchanged.
 */
export async function withRegisteredProjectLock<T>(root: string, write: () => Promise<T>): Promise<T> {
  return withRegisteredProjectLockWith({
    registered: () => registeredForWrite(root),
    acquire: () => acquireMutationLockBlocking(root, "ordinary"),
    release: () => releaseLock(root),
  }, write);
}

/** The registration look and the gated blocking lock: MECHANISMS, no decision. */
export interface RegisteredProjectGate {
  /** Whether the project carries the portable directory or an expected-scale record. */
  registered(): Promise<boolean>;
  /** Take the gated project lock, waiting for it; a gate refusal THROWS. */
  acquire(): Promise<void>;
  /** Release the project lock. */
  release(): Promise<void>;
}

/** {@link withRegisteredProjectLock} over a {@link RegisteredProjectGate}: THE ONE BODY. */
export async function withRegisteredProjectLockWith<T>(gate: RegisteredProjectGate, write: () => Promise<T>): Promise<T> {
  if (!(await gate.registered())) return write();
  await gate.acquire();
  try {
    return await write();
  } finally {
    await gate.release();
  }
}

/** What a cooperative writer was about to do when the project was busy; it names the operation in the refusal. */
export type CooperativeWrite = "source save" | "source delete" | "schema init";

/**
 * A cooperative writer could not take the project lock within its bounded
 * wait because another llmwiki operation holds it. Raised BEFORE the writer
 * runs: this operation changed no source or schema file. It IS a
 * {@link LockBusyError} (the lock's own error is its `cause`), so a caller
 * that already handles a busy lock keeps working; only the message differs.
 */
export class ProjectBusyError extends LockBusyError {
  constructor(readonly operation: CooperativeWrite, busy: LockBusyError) {
    super(0);
    this.name = "ProjectBusyError";
    this.message = `The project is busy: another llmwiki operation (for example a compile) holds the project lock. This ${operation} did not start and changed no source or schema file. Retry it after that operation finishes.`;
    this.cause = busy;
  }
}

/** Take a lock for `operation`; the lock's busy timeout, and nothing else, becomes a {@link ProjectBusyError}. */
async function acquiredFor(operation: CooperativeWrite, acquire: () => Promise<void>): Promise<void> {
  try {
    await acquire();
  } catch (error) {
    if (error instanceof LockBusyError) throw new ProjectBusyError(operation, error);
    throw error;
  }
}

/** The mechanisms a cooperative writer's lock needs: the registered gate's, plus the raw lock of an unregistered project. */
export interface CooperativeWriterGate extends RegisteredProjectGate {
  /** Take the raw project lock, waiting for it, with NO recovery gate (the project is not registered). A busy timeout THROWS. */
  acquireUnregistered(): Promise<void>;
}

/** Run `write` under the gated lock; a gate refusal or a busy lock throws before `write` runs, and the lock is released on every exit. */
async function underGatedLock<T>(gate: RegisteredProjectGate, operation: CooperativeWrite, write: () => Promise<T>): Promise<T> {
  await acquiredFor(operation, () => gate.acquire());
  try {
    return await write();
  } finally {
    await gate.release();
  }
}

/**
 * Run a cooperative legacy writer under the project lock on EVERY project.
 * A registered project takes the gated lock. An unregistered one takes the
 * raw lock, then looks at the registration again UNDER it: still
 * unregistered, it writes; registered meanwhile, it writes nothing, releases
 * and runs under the gated lock instead. A lock that stays busy past its
 * bounded wait refuses with {@link ProjectBusyError} before `write` runs.
 *
 * @param operation - What the writer does, named in a busy refusal.
 */
export async function withCooperativeWriterLockWith<T>(gate: CooperativeWriterGate, operation: CooperativeWrite, write: () => Promise<T>): Promise<T> {
  if (await gate.registered()) return underGatedLock(gate, operation, write);
  await acquiredFor(operation, () => gate.acquireUnregistered());
  try {
    // The first look was unlocked. Under the lock no transition can start or finish, so this one decides.
    if (!(await gate.registered())) return await write();
  } finally {
    await gate.release();
  }
  // Registration appeared while this writer waited: nothing was written. Start again under the gate.
  return underGatedLock(gate, operation, write);
}

/**
 * {@link withCooperativeWriterLockWith} for the project at `root`.
 *
 * @param root - Project root directory.
 * @param operation - What the writer does, named in a busy refusal.
 * @param write - The writer, unchanged.
 */
export async function withCooperativeWriterLock<T>(root: string, operation: CooperativeWrite, write: () => Promise<T>): Promise<T> {
  return withCooperativeWriterLockWith({
    registered: () => registeredForWrite(root),
    acquire: () => acquireMutationLockBlocking(root, "ordinary"),
    // A first ingest may name a root that does not exist yet: the lock lives inside it, so it is created first.
    acquireUnregistered: async () => { await mkdir(root, { recursive: true }); await acquireLockBlocking(root); },
    release: () => releaseLock(root),
  }, operation, write);
}

/**
 * Save an ingested source under the project lock (the gated lock once the
 * project is registered). Every ingest entry point calls this instead of the
 * bare writer.
 */
export function saveSourceUnderProjectGate(
  root: string, title: string, document: string, source: string,
): ReturnType<typeof saveSource> {
  return withCooperativeWriterLock(root, "source save", () => saveSourceRouted(root, title, document, source));
}
