/**
 * Standard compatibility entry points for gate.
 * The engine receives services; this facade constructs the compiler host.
 */
export { resolveGateChallengeWithHost, approveGateWithHost } from "@atomicstrata/llmwiki-local-workflows";
export type { ApproveGateOptions, GateChallengeV1 } from "@atomicstrata/llmwiki-local-workflows";
import { resolveGateChallengeWithHost, approveGateWithHost } from "@atomicstrata/llmwiki-local-workflows";
import { createLocalWorkflowHost } from "./host.js";
import type { ApproveGateOptions, GateChallengeV1 } from "@atomicstrata/llmwiki-local-workflows";
import type { WorkflowRun } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { BlockingLockOptions } from "@atomicstrata/llmwiki-core/local-workflow-contracts";


/** Resolve and verify the exact gate challenge shown to an operator. */
export async function resolveGateChallenge(
  root: string, runId: string, gateId: string,
): Promise<GateChallengeV1> {
  return resolveGateChallengeWithHost(createLocalWorkflowHost(), root, runId, gateId);
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
  return approveGateWithHost(createLocalWorkflowHost(), root, runId, gateId, opts, lockOptions);
}
