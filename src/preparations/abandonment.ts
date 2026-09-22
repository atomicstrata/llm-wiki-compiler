/**
 * @file src/preparations/abandonment.ts
 * @description Explicit valid-run abandonment (design section 25.1). A run may
 * enter terminal `abandoned` ONLY from a valid-HMAC `recovery-required` state and
 * ONLY under an explicit `--confirm-residual-state` confirmation; every other
 * durable read fails closed. The residual findings written onto the signed
 * terminal transition are RECOMPUTED here from the run's own authenticated durable
 * state — never accepted from the caller — so an operator cannot understate what
 * remained unresolved. The finding set never claims an unknown effect did not
 * happen; it records that the phase, effect, broker request, checkpoint, or
 * handoff obligation was still open when the operator accepted the residual state.
 * Any handed-off Milestone A bundle is left untouched; abandonment stops ordinary
 * recovery. The caller holds the project lock (acquired under the quarantine
 * recovery-gate intent) before invoking this writer.
 */

import { readPreparationRun } from "./run-store.js";
import { appendAbandonedTransitionLocked } from "./run-store.js";
import { handoffStartBinding } from "./run-store.js";
import { preparationRunPredecessor } from "./run-integrity.js";
import type { PreparationRunBinding, PreparationRunV1, ResidualFindingV1 } from "./run-types.js";
import type { PreparationPrincipalV1 } from "./run-types.js";

/** Phase-instance states that are fully settled and carry no residual obligation. */
const SETTLED_PHASE_STATES = new Set([
  "succeeded", "succeeded-with-warnings", "skipped-optional", "cancelled", "superseded", "failed",
]);

/** Effect outcomes that are fully settled (applied, terminally refused, or failed). */
const SETTLED_EFFECT_OUTCOMES = new Set(["applied", "already-applied", "refused", "failed"]);

/** Explicit residual-state confirmation and abandonment principal/timestamp. */
export interface AbandonPreparationInput {
  binding: PreparationRunBinding;
  actor: PreparationPrincipalV1;
  at: string;
  confirmResidualState: boolean;
}

/** Typed fail-closed refusal naming why abandonment could not proceed. */
export class PreparationAbandonmentError extends Error {
  constructor(readonly code: "run-unavailable" | "not-recovery-required" | "confirmation-required", message: string) {
    super(message);
    this.name = "PreparationAbandonmentError";
  }
}

/** Recompute every open phase obligation from the authenticated phase summaries. */
function phaseFindings(run: PreparationRunV1): ResidualFindingV1[] {
  const findings: ResidualFindingV1[] = [];
  for (const phase of run.phaseSummaries) {
    if (!SETTLED_PHASE_STATES.has(phase.state)) {
      findings.push({ code: "unresolved-phase", phaseInstanceId: phase.phaseInstanceId });
    }
    if (phase.checkpointDigest !== undefined && !SETTLED_PHASE_STATES.has(phase.state)) {
      findings.push({ code: "unresolved-checkpoint", phaseInstanceId: phase.phaseInstanceId });
    }
  }
  return findings;
}

/** Recompute every open effect and broker-request obligation from durable summaries. */
function effectFindings(run: PreparationRunV1): ResidualFindingV1[] {
  const findings: ResidualFindingV1[] = [];
  for (const effect of run.effectSummaries) {
    if (!SETTLED_EFFECT_OUTCOMES.has(effect.outcome)) findings.push({ code: `unresolved-effect-${effect.outcome}` });
  }
  for (const broker of run.brokerRequestSummaries) {
    if (broker.state !== "settled") findings.push({ code: `unresolved-broker-${broker.state}` });
  }
  return findings;
}

/**
 * Derive the complete, bounded residual finding set from the run's own durable
 * authority: every unsettled phase, checkpoint, effect, and broker request, plus a
 * marker when a durable handoff was started but never settled (its immutable
 * Milestone A bundle, if any, remains authoritative and untouched).
 */
export function deriveResidualFindings(run: PreparationRunV1): ResidualFindingV1[] {
  const findings = [...phaseFindings(run), ...effectFindings(run)];
  if (handoffStartBinding(run) !== undefined && run.handoff === undefined) {
    findings.push({ code: "unsettled-handoff-marker" });
  }
  return findings;
}

/**
 * Abandon a valid-HMAC `recovery-required` run with recomputed residual findings.
 * Fails closed on any other durable read or a missing confirmation, and never
 * fabricates or trusts caller-supplied findings.
 */
export async function abandonPreparationRunLocked(root: string, input: AbandonPreparationInput): Promise<PreparationRunV1> {
  if (input.confirmResidualState !== true) {
    throw new PreparationAbandonmentError("confirmation-required", "abandonment requires explicit residual-state confirmation");
  }
  const read = await readPreparationRun(root, input.binding);
  if (read.status !== "ok") {
    throw new PreparationAbandonmentError("run-unavailable", `preparation run is ${read.status}`);
  }
  if (read.run.state !== "recovery-required") {
    throw new PreparationAbandonmentError("not-recovery-required", `abandonment requires recovery-required, saw ${read.run.state}`);
  }
  const findings = deriveResidualFindings(read.run);
  return appendAbandonedTransitionLocked(root, input.binding, preparationRunPredecessor(read.run), {
    actor: { id: input.actor.id, surface: input.actor.surface }, at: input.at,
    confirmResidualState: true, findings,
  });
}
