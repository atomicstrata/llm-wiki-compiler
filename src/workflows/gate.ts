/**
 * @file src/workflows/gate.ts
 * @description The `approveGate` operation: record that a `human:`/`agent:` gate
 * on the run's CURRENT stage is satisfied, with strict actor-kind enforcement.
 *
 * A gate is approved for the stage the run is sitting on (resolved from the
 * profile, the same way `advance` resolves its current stage). Only that stage's
 * gate is approvable, and only by an actor whose kind can satisfy it: a `human:`
 * gate requires a `human` actor; an `agent:` gate accepts an `agent` OR a
 * `human` (a human may stand in for an agent), never a `system` actor. This is
 * THE security rule — an agent can never satisfy a human gate. `trust:` gates
 * are NOT approvable here ({@link TrustGateNotHereError}); their satisfaction
 * (write path + Trust Guard) is the next slice.
 *
 * On success the gate's full `<kind>:<id>` string is added to
 * `satisfiedGates`, the stage's `awaiting-gate` park is cleared back to
 * `running` (so a subsequent `advance` proceeds), and a `gate-approved` event is
 * recorded atomically via {@link appendRunEvent}. Approval is idempotent: a gate
 * already satisfied returns the run UNCHANGED (no duplicate event/version bump).
 * The whole op runs under the project lock with a fail-closed read.
 */

import { appendRunEvent } from "./events.js";
import { resolveCurrentStage } from "./advance.js";
import { parseGate, type GateKind } from "./gates.js";
import { assertActorLabelWithinCap } from "./field-limits.js";
import { readRun, writeRun } from "./store.js";
import {
  RunNotActiveError,
  RunUnavailableError,
  UnknownGateError,
  GateActorMismatchError,
  TrustGateNotHereError,
} from "./errors.js";
import { withRunLock, isTerminalStatus } from "./with-lock.js";
import { maybeAutoProject } from "./projection.js";
import type { BlockingLockOptions } from "../utils/lock.js";
import type { WorkflowActorKind, WorkflowRun } from "./types.js";

/** Who is approving the gate (the security-relevant kind, plus an optional label). */
export interface ApproveGateOptions {
  /** The actor kind performing the approval (enforced against the gate's required kind). */
  actorKind: WorkflowActorKind;
  /** Optional free-form label identifying the actor (e.g. a username or agent id). */
  actorLabel?: string;
}

/** True when `actorKind` can satisfy a gate of `gateKind` (the security rule). */
function actorSatisfies(gateKind: GateKind, actorKind: WorkflowActorKind): boolean {
  if (gateKind === "human") return actorKind === "human";
  if (gateKind === "agent") return actorKind === "human" || actorKind === "agent";
  return false;
}

/**
 * Resolve the current stage's gate, requiring it to match `gateId` and to be an
 * approvable (non-`trust`) kind the actor can satisfy. Throws fail-closed for
 * every mismatch; returns the full `<kind>:<id>` gate string on success.
 */
function vouchGate(run: WorkflowRun, gate: string | undefined, gateId: string, opts: ApproveGateOptions): string {
  const parsed = gate === undefined ? null : parseGate(gate);
  if (parsed === null || parsed.id !== gateId) throw new UnknownGateError(run.runId, gateId);
  if (parsed.kind === "trust") throw new TrustGateNotHereError(run.runId, gateId);
  if (!actorSatisfies(parsed.kind, opts.actorKind)) {
    throw new GateActorMismatchError(run.runId, gateId, parsed.kind, opts.actorKind);
  }
  return `${parsed.kind}:${gateId}`;
}

/** Return a NEW run with the current stage's `awaiting-gate` entry flipped to `running`. */
function clearStagePark(run: WorkflowRun): WorkflowRun["stageLog"] {
  return run.stageLog.map((entry) =>
    entry.stageId === run.currentStage && entry.status === "awaiting-gate"
      ? { ...entry, status: "running" }
      : entry,
  );
}

/** Record the satisfied gate + `gate-approved` event and persist the result. */
async function recordApproval(root: string, run: WorkflowRun, fullGate: string, gateId: string, opts: ApproveGateOptions): Promise<WorkflowRun> {
  const bumped = appendRunEvent(run, {
    type: "gate-approved",
    at: new Date().toISOString(),
    actorKind: opts.actorKind,
    actorLabel: opts.actorLabel,
    gateId,
    stageId: run.currentStage ?? undefined,
  });
  const approved: WorkflowRun = {
    ...bumped,
    satisfiedGates: [...bumped.satisfiedGates, fullGate],
    stageLog: clearStagePark(bumped),
  };
  await writeRun(root, approved);
  return approved;
}

/**
 * Resolve the KIND (`human`/`agent`/`trust`) of the gate `gateId` on the run's
 * CURRENT stage — the read the CLI uses to decide whether the interactive
 * human-proof (C1) is required BEFORE it calls {@link approveGate}.
 *
 * Reads the run fail-closed (an absent/unavailable run → {@link RunUnavailableError})
 * and resolves the current stage's declared gate; throws {@link UnknownGateError}
 * when the current stage declares no gate matching `gateId`. Takes no lock (a pure
 * read of an immutable-per-stage gate declaration).
 *
 * @param root - Absolute project root.
 * @param runId - The run whose current-stage gate kind to resolve.
 * @param gateId - The id part of the gate to resolve.
 * @returns The gate's {@link GateKind}.
 * @throws {RunUnavailableError} When the run is absent/unavailable.
 * @throws {UnknownGateError} When the current stage declares no matching gate.
 */
export async function resolveGateKind(root: string, runId: string, gateId: string): Promise<GateKind> {
  const read = await readRun(root, runId);
  if (read.status === "absent") throw new RunUnavailableError(runId, "absent");
  if (read.status === "unavailable") throw new RunUnavailableError(runId, read.detail);
  const { stage } = await resolveCurrentStage(root, read.run);
  const parsed = stage.gate === undefined ? null : parseGate(stage.gate);
  if (parsed === null || parsed.id !== gateId) throw new UnknownGateError(runId, gateId);
  return parsed.kind;
}

/**
 * Approve a `human:`/`agent:` gate on the run's current stage.
 *
 * Under the project lock with a fail-closed read: rejects terminal runs
 * ({@link RunNotActiveError}); resolves the current stage def; requires that
 * stage to declare a gate whose id equals `gateId` ({@link UnknownGateError});
 * rejects `trust:` gates ({@link TrustGateNotHereError}); enforces the actor
 * kind ({@link GateActorMismatchError}). On success — when not already satisfied
 * — records the gate, clears the stage's `awaiting-gate` park, and appends a
 * `gate-approved` event. Idempotent: an already-satisfied gate returns the run
 * unchanged.
 *
 * @param root - Absolute project root.
 * @param runId - The slug-safe run id to approve a gate on.
 * @param gateId - The id part of the current stage's gate to satisfy.
 * @param opts - The approving actor's kind and optional label.
 * @param lockOptions - Bounded-blocking acquire overrides (timeout/poll interval).
 * @returns The persisted run (unchanged when the gate was already satisfied).
 * @throws {LockBusyError} When the lock stays held past the bounded timeout.
 * @throws {RunUnavailableError} When the run is absent/unavailable or has no current stage.
 * @throws {RunNotActiveError} When the run is already terminal.
 * @throws {UnknownGateError} When the current stage declares no matching gate.
 * @throws {TrustGateNotHereError} When the gate is a `trust:` gate.
 * @throws {GateActorMismatchError} When the actor kind cannot satisfy the gate.
 * @throws {WorkflowFieldTooLongError} When `opts.actorLabel` exceeds its cap.
 */
export async function approveGate(
  root: string,
  runId: string,
  gateId: string,
  opts: ApproveGateOptions,
  lockOptions: BlockingLockOptions = {},
): Promise<WorkflowRun> {
  assertActorLabelWithinCap(opts.actorLabel);
  const run = await withRunLock(root, runId, async (locked) => {
    if (isTerminalStatus(locked.status)) throw new RunNotActiveError(runId, locked.status);
    const { stage } = await resolveCurrentStage(root, locked);
    const fullGate = vouchGate(locked, stage.gate, gateId, opts);
    if (locked.satisfiedGates.includes(fullGate)) return locked;
    return recordApproval(root, locked, fullGate, gateId, opts);
  }, lockOptions);
  await maybeAutoProject(root, run);
  return run;
}
