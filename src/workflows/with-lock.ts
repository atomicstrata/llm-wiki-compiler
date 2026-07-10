/**
 * @file src/workflows/with-lock.ts
 * @description The lock + fail-closed-read scaffolding shared by lifecycle ops.
 *
 * cancel/fail/resume/advance all begin the same way: acquire the project lock
 * BOUNDED-BLOCKING (a transiently-busy lock RETRIES, then throws
 * {@link LockBusyError} on timeout — the SAME contract as `submitStageOutput`, so
 * the whole workflow surface behaves consistently), read the run through the
 * confined store FAILING CLOSED (`absent`/`unavailable` → {@link RunUnavailableError}),
 * run the operation body, and ALWAYS release the lock. {@link withRunLock}
 * factors exactly that boundary so each op file holds only its own state logic.
 *
 * The body receives the validated run and returns whatever it computed; this
 * helper persists NOTHING — writing the mutated run is the body's job (it owns
 * the {@link appendRunEvent} version bump + event, which must stay atomic with
 * the write decision). The helper just guarantees the lock + fail-closed read.
 */

import { acquireLockBlocking, releaseLock, type BlockingLockOptions } from "../utils/lock.js";
import { appendRunEvent, appendTerminalEvent } from "./events.js";
import { readRun, writeRun, writeTerminalRun } from "./store.js";
import { RunOwnerMismatchError, RunUnavailableError } from "./errors.js";
import { currentActorIdentity } from "./actor-identity.js";
import type { WorkflowEvent, WorkflowRun } from "./types.js";

/**
 * Enforce run OWNERSHIP (M1) — THE single source consulted by EVERY mutating
 * runId-bearing op (the direct `cancel`/`advance`/`resume`/`gate`/`adapt`/`fail` via
 * {@link withRunLock}, the `submitStageOutput` write path, AND the action surface's
 * pre-dispatch guard). A run whose recorded `owner` DIFFERS from the current caller
 * identity ({@link currentActorIdentity}) is refused with {@link RunOwnerMismatchError},
 * so caller B cannot mutate caller A's run on ANY surface. An OWNER-LESS (legacy/pre-M1)
 * run is unrestricted (back-compat). Advisory, NOT cryptographic — a hostile local
 * agent sets `LLMWIKI_ACTOR` freely; the real boundary is OS-level isolation (see
 * {@link ./actor-identity.ts}).
 *
 * @param run - The run whose ownership to enforce against the current caller.
 * @throws {RunOwnerMismatchError} When the run's owner differs from the caller.
 */
export function assertRunOwnership(run: WorkflowRun): void {
  if (run.owner === undefined) return; // legacy/owner-less runs are unrestricted
  const caller = currentActorIdentity();
  if (run.owner !== caller) throw new RunOwnerMismatchError(run.runId, run.owner, caller);
}

/**
 * Run `body` under the project lock with a fail-closed-read `run`.
 *
 * Acquires the lock BOUNDED-BLOCKING (a transiently-busy lock retries until it
 * frees or the timeout elapses, then throws {@link LockBusyError}) and ALWAYS
 * releases it in `finally`. Reads `runId` through the confined store and throws
 * {@link RunUnavailableError} on `absent`/`unavailable` (never proceeds on a run
 * it cannot vouch for). ENFORCES run OWNERSHIP (M1) on the read run via
 * {@link assertRunOwnership} — so EVERY mutating op funnelled through this lock
 * (cancel/advance/resume/gate/adapt/fail) refuses a non-owning caller, not just the
 * action surface. On a clean, owned read, returns whatever `body` returns.
 *
 * @param root - Absolute project root.
 * @param runId - The slug-safe run id to read and act on.
 * @param body - The operation body; receives the validated run, returns its result.
 * @param lockOptions - Bounded-blocking acquire overrides (timeout/poll interval).
 * @returns The value `body` returned.
 * @throws {LockBusyError} When the lock stays held past the bounded timeout.
 * @throws {RunUnavailableError} When the run is absent or unavailable.
 * @throws {RunOwnerMismatchError} When the run is owned by a different caller.
 */
export async function withRunLock<T>(
  root: string,
  runId: string,
  body: (run: WorkflowRun) => Promise<T>,
  lockOptions: BlockingLockOptions = {},
): Promise<T> {
  await acquireLockBlocking(root, lockOptions);
  try {
    const read = await readRun(root, runId);
    if (read.status === "absent") throw new RunUnavailableError(runId, "absent");
    if (read.status === "unavailable") throw new RunUnavailableError(runId, read.detail);
    assertRunOwnership(read.run);
    return await body(read.run);
  } finally {
    await releaseLock(root);
  }
}

/**
 * Append `event` to `run` (atomic version bump via {@link appendRunEvent}), apply
 * the `patch` of run-level fields, persist, and return the result.
 *
 * The single shared "record an event + commit a status transition" tail for the
 * cancel/fail/resume ops, so each holds only its own status/stage edits and event
 * type. (advance does not use this — its multi-stage edits between bump and write
 * are bespoke.)
 *
 * @param root - Absolute project root.
 * @param run - The run to transition (already shape-prepared by the caller).
 * @param event - The lifecycle event to record (sans before/after versions).
 * @param patch - Run-level field overrides applied after the bump (e.g. `status`).
 *   TYPED to EXCLUDE `stateVersion`/`events`/`updatedAt`: those are owned by the
 *   {@link appendRunEvent} bump, and the `patch` is spread AFTER it, so allowing
 *   them would let a caller silently clobber the version bump / audit trail.
 * @returns The persisted run.
 */
export async function commitRunEvent(
  root: string,
  run: WorkflowRun,
  event: Omit<WorkflowEvent, "stateVersionBefore" | "stateVersionAfter">,
  patch: Partial<Omit<WorkflowRun, "stateVersion" | "events" | "updatedAt">>,
): Promise<WorkflowRun> {
  const committed: WorkflowRun = { ...appendRunEvent(run, event), ...patch };
  await writeRun(root, committed);
  return committed;
}

/**
 * Like {@link commitRunEvent} but for the TERMINAL ops (`cancel`/`fail`): records
 * the terminal event via {@link appendTerminalEvent} (which COMPACTS the trail
 * rather than throwing at the event cap) and persists via {@link writeTerminalRun}
 * (which MINIMIZES the record rather than throwing at the byte cap). So a terminal
 * status flip ALWAYS persists — a run at/over either cap is never an un-retireable
 * zombie. Returns the run AS PERSISTED (its trail may be compacted and its
 * inputs/outputs may have been dropped to fit the byte cap).
 *
 * @param root - Absolute project root.
 * @param run - The run to terminate (already shape-prepared by the caller).
 * @param event - The terminal lifecycle event to record (sans before/after versions).
 * @param patch - Run-level field overrides applied after the bump (e.g. `status`).
 * @returns The persisted (possibly compacted/minimized) terminal run.
 */
export async function commitTerminalEvent(
  root: string,
  run: WorkflowRun,
  event: Omit<WorkflowEvent, "stateVersionBefore" | "stateVersionAfter">,
  patch: Partial<Omit<WorkflowRun, "stateVersion" | "events" | "updatedAt">>,
): Promise<WorkflowRun> {
  const committed: WorkflowRun = { ...appendTerminalEvent(run, event), ...patch };
  return writeTerminalRun(root, committed);
}

/** The run statuses that are terminal (no further lifecycle action). */
const TERMINAL_STATUSES = ["completed", "cancelled", "failed"] as const;

/** True when `status` is a terminal run status. */
export function isTerminalStatus(status: WorkflowRun["status"]): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}
