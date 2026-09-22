/**
 * @file src/operation-bundles/compensation.ts
 * @description Idempotent, durable compensation. Automatic compensation runs only
 * when all five conditions hold: authority is unchanged, every applied mutation is
 * still at its post-state, every applied mutation has a registered host
 * compensator (declared in the run obligations AND present on the core adapter),
 * a cancellation or mid-apply failure triggered it, and a durable reverse-order
 * intent (compensation-began) is recorded before the first compensator. Any failed
 * condition parks the run at recovery-required instead of compensating. Each
 * compensator is a closed function on the core adapter object (never manifest
 * code); its outcome is durable by `opc_` identity and observed before and after,
 * so a crash resumes idempotently and a conflict or unavailable read parks.
 */

import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { requireOperationAdapter } from "./adapter-registry.js";
import { removeCancelRequestLocked } from "./cancel-request.js";
import type { AdapterContext } from "./adapter-types.js";
import { currentApplyOwner } from "./apply-owner.js";
import type { OperationAuthoritySnapshot } from "./authority.js";
import { writeRunEvidenceCreateOnly } from "./evidence-store.js";
import {
  appendRunStep, buildAdapterContext, computeAuthoritySnapshot, loadRunSession, runResult,
  type ApproveOperationBundleRequest, type OperationActionResult, type RunSession,
} from "./executor.js";
import { compensationId, type CompensationId } from "./ids.js";
import type { OperationEvidenceReference, OperationRun } from "./run-types.js";
import type { OperationMutation } from "./types.js";

/** What made compensation eligible (condition four). */
export type CompensationTrigger = "cancellation" | "apply-failure";

/** One compensation step's resulting run and whether it parked. */
interface CompensationStep { run: OperationRun; parked: boolean }

/** Every authoritative mutation this run actually applied (not skipped). */
function appliedMutations(run: OperationRun, manifest: RunSession["manifest"]): OperationMutation[] {
  const applied = new Set(run.mutationOutcomes.filter((outcome) => outcome.status === "applied").map((outcome) => outcome.mutationId));
  return manifest.mutations.filter((mutation) => mutation.kind !== "projection" && applied.has(mutation.mutationId));
}

/** The current compensation outcome status for one compensation identity. */
function currentCompensationOutcome(run: OperationRun, id: CompensationId): "started" | "completed" | "failed" | undefined {
  return run.compensationOutcomes.find((outcome) => outcome.compensationId === id)?.status;
}

/** Whether a mutation is declared compensatable and its adapter exposes a compensator. */
function hasCompensator(run: OperationRun, session: RunSession, mutation: OperationMutation): boolean {
  const declared = run.obligations.compensations.some((item) => item.mutationId === mutation.mutationId);
  return declared && session.request.runtime.adapters.get(mutation.kind)?.compensate !== undefined;
}

/** Persist bounded compensation evidence out-of-line for a durable outcome. */
async function compensationEvidence(session: RunSession, mutation: OperationMutation, status: "completed" | "failed"): Promise<OperationEvidenceReference> {
  const bytes = canonicalBytes({ compensationId: compensationId(mutation.mutationId), mutationId: mutation.mutationId, status });
  return writeRunEvidenceCreateOnly(session.root, {
    workspaceId: session.manifest.workspaceId, runId: session.binding.runId, type: mutation.kind, provenance: "compensate",
  }, Buffer.from(bytes));
}

/** Park the run at recovery-required without compensating (a gate condition failed). */
async function parkWithoutCompensation(session: RunSession, run: OperationRun): Promise<OperationActionResult> {
  if (run.state === "recovery-required") return runResult(run, "bundle-recovery-required");
  return runResult(await appendRunStep(session, run, { kind: "recovery-required", code: "bundle-recovery-required" }), "bundle-recovery-required");
}

/** Prove every applied mutation is still exactly at its post-state (condition two). */
async function appliedStillAtPostState(session: RunSession, snapshot: OperationAuthoritySnapshot, applied: OperationMutation[]): Promise<boolean> {
  for (const mutation of applied) {
    const adapter = requireOperationAdapter(session.request.runtime.adapters, mutation.kind);
    const observation = await adapter.observe(buildAdapterContext(session, snapshot, mutation));
    if (observation.outcome !== "applied") return false;
  }
  return true;
}

/** Record the failed compensation outcome (with evidence) and park at recovery-required. */
async function parkCompensationFailed(session: RunSession, run: OperationRun, id: CompensationId, mutation: OperationMutation): Promise<CompensationStep> {
  run = await appendRunStep(session, run, { kind: "compensation-outcome", compensationId: id, mutationId: mutation.mutationId, status: "failed", evidence: await compensationEvidence(session, mutation, "failed") });
  return { run: await appendRunStep(session, run, { kind: "recovery-required", code: "bundle-recovery-required" }), parked: true };
}

/**
 * Re-observe after a compensator self-reports reversal: the effect is gone only
 * when observation is exactly `not-applied`. A still-present effect (`applied` or
 * `partially-applied`), an unreadable/conflicting store, or a faulting observe all
 * fail closed — the compensator's returned status is never trusted alone (INV-11).
 */
async function compensationEffectGone(session: RunSession, snapshot: OperationAuthoritySnapshot, mutation: OperationMutation): Promise<boolean> {
  const adapter = requireOperationAdapter(session.request.runtime.adapters, mutation.kind);
  try {
    const observation = await adapter.observe(buildAdapterContext(session, snapshot, mutation));
    return observation.outcome === "not-applied";
  } catch {
    return false;
  }
}

/** Run one idempotent compensator, observing before and after and recording durably. */
async function runOneCompensation(session: RunSession, snapshot: OperationAuthoritySnapshot, run: OperationRun, mutation: OperationMutation): Promise<CompensationStep> {
  const id = compensationId(mutation.mutationId);
  if (currentCompensationOutcome(run, id) === "completed") return { run, parked: false };
  const adapter = requireOperationAdapter(session.request.runtime.adapters, mutation.kind);
  const ctx: AdapterContext = buildAdapterContext(session, snapshot, mutation);
  if (currentCompensationOutcome(run, id) !== "started") {
    run = await appendRunStep(session, run, { kind: "compensation-started", compensationId: id, mutationId: mutation.mutationId });
  }
  await session.request.runtime.fault?.beforeCompensate?.(id);
  const result = await adapter.compensate!(ctx);
  await session.request.runtime.fault?.afterCompensate?.(id);
  if (result.status === "conflict" || result.status === "unavailable") return parkCompensationFailed(session, run, id, mutation);
  // A returned reversal is a self-report; require the effect to be observably gone
  // before recording success, else park rather than falsely report it compensated.
  if (!(await compensationEffectGone(session, snapshot, mutation))) return parkCompensationFailed(session, run, id, mutation);
  run = await appendRunStep(session, run, { kind: "compensation-outcome", compensationId: id, mutationId: mutation.mutationId, status: "completed", evidence: await compensationEvidence(session, mutation, "completed") });
  return { run, parked: false };
}

/**
 * Automatically compensate a run in `applying`, `recovery-required`, or (resuming
 * a crash) `compensating`. The caller
 * supplies the trigger (cancellation or apply-failure); the gate proves the other
 * four conditions before recording the durable reverse-order intent and running
 * each compensator in reverse. Any gate failure or compensator conflict parks the
 * run without a partial or false compensation.
 */
export async function compensateOperationBundleLocked(root: string, request: ApproveOperationBundleRequest, trigger: CompensationTrigger): Promise<OperationActionResult> {
  const loaded = await loadRunSession(root, request);
  if (loaded.status === "problem") return loaded.result;
  const { session } = loaded;
  let run = loaded.run;
  const resuming = run.state === "compensating";
  if (!resuming && run.state !== "applying" && run.state !== "recovery-required") return runResult(run);
  const apply = await computeAuthoritySnapshot(session);
  if (apply.status !== "ok" || apply.digest !== run.authoritySnapshotDigest) return parkWithoutCompensation(session, run);
  const applied = appliedMutations(run, session.manifest);
  if (!resuming) {
    // Initial eligibility gate — an already-compensating run resumes idempotently
    // without re-observing post-state (some effects are already reverted).
    if (applied.some((mutation) => !hasCompensator(run, session, mutation)) || !(await appliedStillAtPostState(session, apply.snapshot, applied))) {
      return parkWithoutCompensation(session, run);
    }
    run = await appendRunStep(session, run, { kind: "compensation-began", authoritySnapshotDigest: apply.digest, applyOwner: currentApplyOwner() });
  }
  for (const mutation of [...applied].reverse()) {
    const step = await runOneCompensation(session, apply.snapshot, run, mutation);
    run = step.run;
    if (step.parked) return runResult(run, "bundle-recovery-required");
  }
  run = await appendRunStep(session, run, { kind: "compensated" });
  // Settlement complete: the lock holder removes the non-authoritative advisory file.
  if (trigger === "cancellation") await removeCancelRequestLocked(session.root, session.manifest.workspaceId, session.binding.runId);
  return runResult(run);
}
