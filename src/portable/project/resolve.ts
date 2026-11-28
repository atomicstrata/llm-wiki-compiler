/**
 * @file src/portable/project/resolve.ts
 * @description Operation status, and the one bounded way out of a parked
 * operation.
 *
 * `status` needs only what a caller holds after a lost response: the operation
 * id. `operation.resolve` is privileged and closed: it never discards blindly.
 * It observes every target twice under the gate and acts only if both
 * observations show the same EXACT bytes — the same content digest, or
 * absence — for every target; a target whose bytes cannot be read is never
 * proven unchanged. The digests are internal evidence: the record keeps only
 * each target's `{ path, observed }`. Eligibility is decided again on the final
 * observation. This narrows, but cannot close, the window against a
 * non-cooperating writer: a change after the final observation is not seen.
 *
 * `accept-external-bytes` records `abandoned`: neither committed nor refused.
 * It is allowed whenever conditional rollback cannot safely complete — a target
 * that matches neither image, or a pre-image that is missing or damaged — and
 * every target's bytes could be read; it overwrites nothing. An approval it
 * held stays consumed.
 */

import { recoverLocked, statusOf, type Authority } from "../authority/status.js";
import type { ContentDigest, PublicationStatus, ResolutionRecordV1, TargetObservation } from "../contracts.js";
import { holdsAtEffect } from "../authority/authority.js";
import { PortableDenied } from "../errors.js";
import { authorize } from "../host/policy.js";
import { IntentTargetsChangedError, type IntentObservation } from "../store/store.js";
import type { ResolveOutcome, ResolveRequest } from "./api.js";
import type { ProjectRuntime } from "./runtime.js";

/** Read one operation's recorded state by id, within the caller's actor scope. */
export async function operationStatus(
  runtime: ProjectRuntime, operationId: string, expectedIntentDigest?: ContentDigest,
): Promise<PublicationStatus> {
  await authorize(runtime.control, runtime.principal, "project.open");
  const gate = runtime.store.withStatusGate?.bind(runtime.store) ?? ((fn) => runtime.store.withGate(() => fn(true)));
  return gate(async (mayRecover: boolean) => {
    // Entitlement is read from CURRENT host state inside the gate, and BEFORE
    // recovery runs: a caller revoked while it waited triggers no recovery of
    // its own. (The store's host-owned completion of an already committed
    // operation's labels runs at the gate for anyone; it is not this caller's.)
    if (!(await holdsAtEffect(runtime, runtime.principal, ["project.open"]))) return { kind: "not_found" };
    const mayReadOthers = await holdsAtEffect(runtime, runtime.principal, ["operation.read"]);
    // When the store cannot finish a commit's labels it allows no recovery: the receipt alone answers.
    if (mayRecover) await recoverLocked(runtime);
    const record = await runtime.store.getIdentity(operationId);
    // Another actor's operation and a missing one are the same answer.
    if (record === null || (record.actor !== runtime.principal.actor && !mayReadOthers)) return { kind: "not_found" };
    if (expectedIntentDigest !== undefined && expectedIntentDigest !== record.intentDigest) {
      return { kind: "intent_mismatch" };
    }
    return statusOf(runtime, record);
  });
}

/** Whether `decision` is allowed against what the targets hold now. */
function isDecisionAllowed(request: ResolveRequest, observation: IntentObservation): boolean {
  const hasUnowned = observation.targets.some((target) => target.observed === "neither");
  if (request.decision === "roll-back-own-writes") return !hasUnowned && observation.preimagesVerify;
  // Bytes that could not be read cannot be accepted: nothing would say what was accepted.
  if (observation.evidence.some((seen) => seen.state === "unverifiable")) return false;
  // Honest abandonment is permitted whenever rollback cannot safely complete (C3).
  return hasUnowned || !observation.preimagesVerify;
}

/**
 * True only when two observations show the SAME exact state for every target:
 * the same content digest, or absence. The class alone is not enough (a target
 * replaced by a different hand edit stays "neither"), and an unverifiable
 * target is never proven unchanged, not even against another unverifiable one.
 */
function isSameExactState(first: IntentObservation, final: IntentObservation): boolean {
  if (first.evidence.length !== final.evidence.length || first.targets.length !== final.targets.length) return false;
  return first.evidence.every((seen, index) => {
    const later = final.evidence[index];
    if (first.targets[index].path !== final.targets[index].path) return false;
    if (seen.state === "unverifiable" || later.state === "unverifiable") return false;
    if (seen.state === "absent" || later.state === "absent") return seen.state === later.state;
    return seen.digest === later.digest;
  });
}

/** The durable, wire-shaped `{ path, observed }` of each target: internal evidence never reaches a record or response. */
function recordedTargets(observation: IntentObservation): TargetObservation[] {
  return observation.targets.map(({ path, observed }) => ({ path, observed }));
}

/** Carry out a roll-back or an abandonment and record the operation's terminal outcome. */
async function closeParked(
  runtime: ProjectRuntime, request: ResolveRequest, observation: IntentObservation,
): Promise<void> {
  const auth: Authority = runtime;
  const record = await auth.store.getIdentity(request.operationId);
  if (request.decision === "roll-back-own-writes") {
    await auth.store.rollBackIntent(request.operationId, observation.targets);
    if (record) await auth.store.putIdentity({ ...record, outcome: "refused", refusal: "recovered_no_effect", detail: "rolled_back" });
    return;
  }
  const resolution: ResolutionRecordV1 = {
    operationId: request.operationId, resolver: runtime.principal.subject, resolvedAt: new Date().toISOString(),
    decision: request.decision, reason: request.reason, targets: recordedTargets(observation),
  };
  await auth.store.abandonIntent(request.operationId, resolution);
  if (record) await auth.store.putIdentity({ ...record, outcome: "abandoned", resolution });
}

/** The operation's status after a resolve step. */
async function resolvedStatus(runtime: ProjectRuntime, operationId: string): Promise<ResolveOutcome> {
  const record = await runtime.store.getIdentity(operationId);
  return { kind: "resolved", status: record ? await statusOf(runtime, record) : { kind: "not_found" } };
}

/**
 * The `roll-back-own-writes` / `accept-external-bytes` path, run INSIDE the gate
 * after the effect-time authority check: observe twice, act only on the same
 * exact bytes, decide eligibility again on the final observation, then close.
 */
async function resolveParked(runtime: ProjectRuntime, request: ResolveRequest): Promise<ResolveOutcome> {
  const observation = await runtime.store.observeIntent(request.operationId);
  if (observation === null) return { kind: "refused", code: "not_parked" };
  if (!isDecisionAllowed(request, observation)) return { kind: "refused", code: "decision_not_allowed" };
  // Re-observe immediately before acting: if any target's exact bytes moved, do nothing.
  const again = await runtime.store.observeIntent(request.operationId);
  if (again === null || !isSameExactState(observation, again)) return { kind: "refused", code: "targets_changed" };
  // Decided again on the FINAL observation: a retained pre-image repaired or lost in between changes eligibility.
  if (!isDecisionAllowed(request, again)) return { kind: "refused", code: "decision_not_allowed" };
  // Not atomic against a non-cooperating writer. A rollback observes the whole set once more
  // and parks, writing nothing, if a target changed class after this final observation.
  try {
    await closeParked(runtime, request, again);
  } catch (error) {
    if (error instanceof IntentTargetsChangedError) return { kind: "refused", code: "targets_changed" };
    throw error;
  }
  runtime.control.audit({ kind: "operation-resolved", ...request, resolver: runtime.principal.subject });
  return resolvedStatus(runtime, request.operationId);
}

/** Resolve one parked operation by one of the three closed decisions. */
export async function resolveOperation(runtime: ProjectRuntime, request: ResolveRequest): Promise<ResolveOutcome> {
  await authorize(runtime.control, runtime.principal, "operation.resolve");
  return runtime.store.withGate(async () => {
    // Decided again INSIDE the gate, immediately before the privileged effect.
    if (!(await holdsAtEffect(runtime, runtime.principal, ["operation.resolve"]))) throw new PortableDenied();
    if (request.decision === "retry-recovery") {
      await recoverLocked(runtime);
      return resolvedStatus(runtime, request.operationId);
    }
    return resolveParked(runtime, request);
  });
}
