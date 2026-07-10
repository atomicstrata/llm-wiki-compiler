/**
 * @file src/workflows/stage-output-internals.ts
 * @description The under-lock apply engine shared by the stage-output arms. Split
 * out of `stage-output.ts` so BOTH it (the page/relation/lifecycle arms) and its
 * sibling `artifact-output.ts` (the artifact arm) reuse the SAME atomicity +
 * trust-gate primitives WITHOUT an import cycle between the two arm modules.
 *
 * It owns the pre-validate → apply → record discipline ({@link preflightApplyRecord}
 * and its intent-marker helpers) and the `trust:`-gate refusal for the non-page
 * kinds ({@link guardTrustGatedNonPageWrite}) — the load-bearing invariants every
 * applied write depends on. These carry the run-store I/O; the arm modules layer
 * their kind-specific scope guards + planner/executor routing on top.
 */

import { appendRunEvent } from "./events.js";
import { isTrustGate } from "./gates.js";
import { isTrustedWriteGranted } from "./trusted-write.js";
import { writeRun, serializeRunWithinCap } from "./store.js";
import { TrustGateRequiresGrantError } from "./errors.js";
import type { TrustDecision } from "../trust/decision.js";
import type { WorkflowRun } from "./types.js";
import type { WorkflowStageDef } from "../profile/types.js";

/** The result of submitting a stage output. */
export interface SubmitResult {
  /** The run as persisted after the submission. */
  run: WorkflowRun;
  /** Whether the write landed LIVE (true only on an `allow`/`allow-with-warning`). */
  applied: boolean;
  /** The composed Trust Guard decision for the write. */
  decision: TrustDecision;
}

/**
 * The longest a {@link TrustDecision} literal can be (`"allow-with-warning"`) —
 * the worst-case placeholder used when PRE-VALIDATING a record whose real decision
 * is only known AFTER the external apply, so the validated size is an upper bound.
 */
export const WORST_CASE_DECISION: TrustDecision = "allow-with-warning";

/** Add `stage.gate` to `satisfiedGates` (deduped) iff it is a `trust:` gate. */
function satisfyTrustGate(gates: string[], stage: WorkflowStageDef): string[] {
  if (isTrustGate(stage.gate) && stage.gate !== undefined && !gates.includes(stage.gate)) {
    return [...gates, stage.gate];
  }
  return gates;
}

/**
 * Build the candidate run that recording an applied output WOULD produce: append
 * the `stage-output` event (this enforces the event-count cap and THROWS
 * {@link WorkflowEventOverflowError} HERE — before any external apply), store
 * `outputRef` under `outputs[stage.id]`, and satisfy a `trust:` gate. Pure: no I/O.
 */
function projectAppliedRun(
  run: WorkflowRun,
  stage: WorkflowStageDef,
  decision: TrustDecision,
  outputRef: Record<string, unknown>,
): WorkflowRun {
  const at = new Date().toISOString();
  const bumped = appendRunEvent(run, { type: "stage-output", at, actorKind: "agent", stageId: stage.id, decision });
  const { pendingOutput: _cleared, ...rest } = bumped; // CLEAR the intent marker on success.
  return {
    ...rest,
    outputs: { ...bumped.outputs, [stage.id]: outputRef },
    satisfiedGates: satisfyTrustGate(bumped.satisfiedGates, stage),
  };
}

/**
 * The deterministic op id for a stage-output's in-flight external write:
 * `${runId}:${stageId}:${stateVersion}`. Stable across a crashed submit and its
 * recovery (the `stateVersion` does not advance until the output is recorded), so
 * an operator can correlate a possibly-landed write with the run that intended it.
 */
function stageOutputOpId(run: WorkflowRun, stage: WorkflowStageDef): string {
  return `${run.runId}:${stage.id}:${run.stateVersion}`;
}

/**
 * Persist the `pendingOutput` INTENT marker (crash-recovery dedup) BEFORE the
 * external apply, so a crash between here and the record-output write leaves a
 * VISIBLE marker the next submit fails closed on. The marker write does NOT advance
 * `stateVersion`, keeping the {@link stageOutputOpId} stable across recovery.
 */
async function persistOutputIntent(root: string, run: WorkflowRun, stage: WorkflowStageDef): Promise<void> {
  const pendingOutput = { stageId: stage.id, opId: stageOutputOpId(run, stage) };
  await writeRun(root, { ...run, pendingOutput });
}

/** The post-apply values substituted into a pre-validated candidate before it is written. */
interface AppliedFacts {
  /** The real composed decision the under-lock authority reached. */
  decision: TrustDecision;
  /** The real output ref to record (each field ≤ its pre-validated placeholder). */
  outputRef: Record<string, unknown>;
}

/**
 * THE atomicity primitive shared by every applied-write kind: PRE-VALIDATE the
 * projected run record, apply the external mutation, then write the real record.
 *
 * 1. Build a WORST-CASE candidate (event-count cap enforced HERE; placeholder
 *    relationId/decision so the validated size is an UPPER BOUND) and
 *    {@link serializeRunWithinCap} it — so an over-event-cap or over-byte-cap
 *    record THROWS BEFORE any external write (no silent unaudited mutation).
 * 2. Only then run `apply` (the external page/relation/lifecycle mutation).
 * 3. Substitute the real post-apply facts (each ≤ its placeholder, so still within
 *    cap) into the candidate and persist it.
 *
 * The only residual failure between the external apply and the final write is a
 * genuine I/O error (ENOSPC/EIO) — inherent and accepted, as the event/relation
 * stores document; the cap-violation class is eliminated.
 */
export async function preflightApplyRecord(
  root: string,
  run: WorkflowRun,
  stage: WorkflowStageDef,
  worstCaseRef: Record<string, unknown>,
  apply: () => Promise<AppliedFacts>,
): Promise<WorkflowRun> {
  // (1) PRE-VALIDATE the upper-bound candidate — throws (event/byte cap) before apply.
  serializeRunWithinCap(projectAppliedRun(run, stage, WORST_CASE_DECISION, worstCaseRef));
  // (2) persist the INTENT marker so a crash mid-apply is visible, not silent.
  await persistOutputIntent(root, run, stage);
  // (3) apply the external mutation only after intent is durably recorded.
  const { decision, outputRef } = await applyOrClearIntent(root, run, apply);
  // (4) substitute the real facts (each ≤ its placeholder), CLEARING the intent.
  const recorded = projectAppliedRun(run, stage, decision, outputRef);
  await writeRun(root, recorded);
  return recorded;
}

/**
 * Run the external `apply`, and on a THROWN failure CLEAR the pre-apply intent
 * marker (restore `run`) before rethrowing. A thrown apply here is a denial /
 * pre-mutation refusal — the external write provably did NOT land — so the marker
 * must NOT linger and strand the run in a fail-closed `pendingOutput` state for a
 * write that never happened. The residual silent-orphan window is only a PROCESS
 * crash between the intent persist and this clear (exactly what the marker exists
 * to catch); an in-process apply throw rolls the marker back.
 */
async function applyOrClearIntent(
  root: string,
  run: WorkflowRun,
  apply: () => Promise<AppliedFacts>,
): Promise<AppliedFacts> {
  try {
    return await apply();
  } catch (err) {
    await writeRun(root, run); // restore the pre-intent record (clears pendingOutput)
    throw err;
  }
}

/**
 * Whether a clean (apply-decision) page write for `stage` must be DOWNGRADED to
 * STAGED rather than auto-applied. A `trust:` stage gate means "trusted review
 * required" (C3): a well-formed `allow` is NOT enough to go live — by DEFAULT it
 * STAGES (gate UNsatisfied), closing the "valid markdown ⇒ live ⇒ gate
 * auto-satisfied" exploit. The ONLY exception is an explicit, out-of-band operator
 * grant ({@link isTrustedWriteGranted}) for the active project. A non-`trust:`
 * stage (or no gate) keeps the normal apply-on-`allow` behavior.
 */
export function trustGateRequiresStaging(stage: WorkflowStageDef, projectId: string): boolean {
  if (!isTrustGate(stage.gate)) return false;
  return !isTrustedWriteGranted(projectId);
}

/**
 * Fail CLOSED for a RELATION/LIFECYCLE/ARTIFACT output to a `trust:`-gated stage
 * WITHOUT the out-of-band operator grant (C3). Unlike a `page` write, these kinds
 * are not even PARKED (no run event records a downgrade) — so the ONLY honest
 * behavior is to REFUSE before any apply: nothing is written, the trust gate is not
 * satisfied, the run is byte-unchanged. The operator must set `LLMWIKI_TRUSTED_WRITE`
 * for the project to permit auto-apply. A clean well-formed output can NEVER
 * auto-satisfy a trust gate on its own.
 */
export function guardTrustGatedNonPageWrite(
  runId: string,
  stage: WorkflowStageDef,
  projectId: string,
  kind: "relation" | "lifecycle-transition" | "artifact",
): void {
  if (trustGateRequiresStaging(stage, projectId)) {
    throw new TrustGateRequiresGrantError(runId, stage.id, kind);
  }
}
