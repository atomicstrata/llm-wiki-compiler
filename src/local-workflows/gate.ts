/**
 * @file src/local-workflows/gate.ts
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
import { parseGate, type GateKind } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { assertActorLabelWithinCap } from "./field-limits.js";
import type { RunWriter } from "./execution-context.js";
import type { LocalWorkflowHost } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import {
  RunNotActiveError,
  RunUnavailableError,
  UnknownGateError,
  GateActorMismatchError,
  TrustGateNotHereError,
} from "./errors.js";
import { withHostRunLock, isTerminalStatus } from "./with-lock.js";
import { runWriter, projectWithHost } from "./execution-context.js";
import { subjectDigestForGate } from "./subject-gate.js";
import { SubjectGateVerificationError } from "./approval-subject.js";
import type { BlockingLockOptions } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { WorkflowActorKind, WorkflowRun } from "@atomicstrata/llmwiki-core/local-workflow-contracts";

/** Who is approving the gate (the security-relevant kind, plus an optional label). */
export interface ApproveGateOptions {
  /** The actor kind performing the approval (enforced against the gate's required kind). */
  actorKind: WorkflowActorKind;
  /** Optional free-form label identifying the actor (e.g. a username or agent id). */
  actorLabel?: string;
  /** Subject digest displayed before a subject-bound human confirmation. */
  expectedSubjectDigest?: string;
}

/** Gate kind plus the optional verified subject shown before confirmation. */
export interface GateChallengeV1 {
  kind: GateKind;
  subjectDigest?: string;
}

/** Parse and match one current stage gate. */
function declaredGateKind(runId: string, gate: string | undefined, gateId: string): GateKind {
  const parsed = gate === undefined ? null : parseGate(gate);
  if (parsed === null || parsed.id !== gateId) throw new UnknownGateError(runId, gateId);
  return parsed.kind;
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
async function recordApproval(
  root: string, run: WorkflowRun, fullGate: string, gateId: string,
  opts: ApproveGateOptions, persist: RunWriter, subjectDigest?: string,
): Promise<WorkflowRun> {
  const bumped = appendRunEvent(run, {
    type: "gate-approved",
    at: new Date().toISOString(),
    actorKind: opts.actorKind,
    actorLabel: opts.actorLabel,
    gateId,
    stageId: run.currentStage ?? undefined,
    subjectDigest,
  });
  const approved: WorkflowRun = {
    ...bumped,
    satisfiedGates: [...bumped.satisfiedGates, fullGate],
    stageLog: clearStagePark(bumped),
  };
  await persist(root, approved);
  return approved;
}

/** Resolve the existing challenge using supplied, passive compiler observations. */
export async function resolveGateChallengeWithHost(host: LocalWorkflowHost,
  root: string, runId: string, gateId: string): Promise<GateChallengeV1> {
  const read = await host.history.read(root, runId);
  if (read.status === "absent") throw new RunUnavailableError(runId, "absent");
  if (read.status === "unavailable") throw new RunUnavailableError(runId, read.detail);
  const { stage } = await resolveCurrentStage(root, read.run, host.profiles.load);
  const kind = declaredGateKind(runId, stage.gate, gateId);
  const subjectDigest = await subjectDigestForGate(root, read.run, stage, gateId, host);
  return subjectDigest === undefined ? { kind } : { kind, subjectDigest };
}

/** Preserve gate actor and exact-subject enforcement over the supplied host transaction. */
export async function approveGateWithHost(host: LocalWorkflowHost, root: string, runId: string,
  gateId: string, opts: ApproveGateOptions, lockOptions: BlockingLockOptions = {}): Promise<WorkflowRun> {
  assertActorLabelWithinCap(opts.actorLabel);
  const run = await withHostRunLock(host, root, runId, async (locked, context) => {
    if (isTerminalStatus(locked.status)) throw new RunNotActiveError(runId, locked.status);
    const { stage } = await resolveCurrentStage(root, locked, host.profiles.load);
    const fullGate = vouchGate(locked, stage.gate, gateId, opts);
    const subjectDigest = await subjectDigestForGate(root, locked, stage, gateId, host);
    if (subjectDigest !== undefined && opts.expectedSubjectDigest !== subjectDigest) {
      throw new SubjectGateVerificationError("confirmation-subject-mismatch");
    }
    if (locked.satisfiedGates.includes(fullGate)) return locked;
    return recordApproval(root, locked, fullGate, gateId, opts, runWriter(context), subjectDigest);
  }, lockOptions);
  await projectWithHost(host, root, run);
  return run;
}
