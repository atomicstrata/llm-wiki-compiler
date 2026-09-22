/**
 * @file src/preparations/gate-driver.ts
 * @description The gate lifecycle the runner owns (Chunk 3 unit C, design v3
 * §4b). The `gate` operation RECORDS a decision without moving the run
 * (`service-gate.ts`), and it binds that decision to the gate phase's INSTANCE —
 * so before an operator can decide, the runner must MATERIALIZE the gate phase
 * instance. BLOCK therefore upserts the gate phase's summary in state
 * `awaiting-gate` and moves the run to `awaiting-gate` in one `phase-progressed`
 * transition; the gate operation can then bind to that instance. RESUME, once a
 * proceed decision has been recorded, settles the same instance `succeeded` and
 * moves the run back to `running`. Both use the existing projected-append family
 * (`upsertPhaseSummary`) and existing transition types — no new durable
 * vocabulary. The gate instance is keyed by the gate phase's `logicalPhaseId`,
 * which is what the gate authority looks the summary up by.
 */

import { acquireMutationLockBlocking } from "../operation-bundles/lock-gate.js";
import { releaseLock } from "../utils/lock.js";
import type { Sha256Digest } from "../capability-providers/types.js";
import { upsertPhaseSummary } from "./attempts/start.js";
import { findApprovedGateProof } from "./gates.js";
import { preparationRunPredecessor } from "./run-integrity.js";
import {
  appendProjectedTransitionLocked, readPreparationRun, type PreparationRunContentProjector,
} from "./run-store.js";
import type { PhaseInstanceId } from "./ids.js";
import type {
  PhaseInstanceState, PhaseSummaryV1,
  PreparationPrincipalV1, PreparationRunBinding, PreparationRunV1,
} from "./run-types.js";

/** The gate phase the runner is driving — enough to bind and materialize its instance. */
export interface GatePhaseV1 {
  readonly logicalPhaseId: string;
  readonly gateId: string;
  readonly disposition: "required" | "optional";
  readonly phaseInstanceId: PhaseInstanceId;
  /** The canonical digest of the plan the gate's approval must be bound to. */
  readonly currentPlanDigest: Sha256Digest;
}

/** The closed outcome of one gate-lifecycle move. */
export type GateMoveV1 =
  | { readonly status: "moved"; readonly run: PreparationRunV1 }
  | { readonly status: "refused"; readonly reason: string };

/**
 * Whether a run carries an OPERATIVE approval for one gate — its LATEST decision
 * is `approved` and bound to the current plan digest. Reuses the authoritative
 * `findApprovedGateProof`, so a later rejection or a plan revision makes an
 * earlier approval inert (a plain "any approval ever" search would let an
 * operator's rejection be silently overridden).
 */
export function hasProceedDecision(run: PreparationRunV1, gate: GatePhaseV1): boolean {
  return findApprovedGateProof(run.gateProofs, gate.gateId, gate.currentPlanDigest) !== undefined;
}

/** The states a run may be blocked at a gate FROM: mid-run, or a LEADING gate on a run not yet started. */
const BLOCKABLE_STATES: ReadonlySet<PreparationRunV1["state"]> = new Set(["running", "planned"]);

/**
 * Move a run to `awaiting-gate` at a gate-role phase (BLOCK), materializing
 * the gate phase instance so the gate operation can bind its decision. Refuses
 * unless the run is `running` — or still `planned`, when the gate LEADS the
 * plan (a run whose first phase is a gate never runs anything before it, and
 * leaving it `planned` would report "suspended" with no gate to decide) —
 * re-checked under the lock, so a concurrent transition that already moved it
 * cannot be overwritten.
 */
export async function blockAtGate(
  root: string, binding: PreparationRunBinding, gate: GatePhaseV1,
  actor: PreparationPrincipalV1, at: string,
): Promise<GateMoveV1> {
  return underGateLock(root, binding, async (run) => {
    if (!BLOCKABLE_STATES.has(run.state)) return { status: "refused", reason: `run is ${run.state}, not running` };
    const next = await appendProjectedTransitionLocked(root, binding, preparationRunPredecessor(run), {
      type: "phase-progressed", stateAfter: "awaiting-gate",
      payload: { kind: "phase", phaseInstanceId: gate.phaseInstanceId, phaseState: "awaiting-gate" },
      actor: { id: actor.id, surface: actor.surface }, at,
    }, gateSummaryProjector(gate, "awaiting-gate"));
    return { status: "moved", run: next };
  });
}

/**
 * Move an `awaiting-gate` run back to `running` once its gate has a proceed
 * decision (RESUME), settling the gate phase instance `succeeded` in the same
 * `phase-progressed` transition. Refuses when the run is not awaiting the gate or
 * the decision is absent, so a resume can never precede its authorization.
 */
export async function resumeFromGate(
  root: string, binding: PreparationRunBinding, gate: GatePhaseV1,
  actor: PreparationPrincipalV1, at: string,
): Promise<GateMoveV1> {
  return underGateLock(root, binding, async (run) => {
    if (run.state !== "awaiting-gate") return { status: "refused", reason: `run is ${run.state}, not awaiting-gate` };
    if (!hasProceedDecision(run, gate)) {
      return { status: "refused", reason: `gate ${gate.gateId} has no operative approval` };
    }
    const next = await appendProjectedTransitionLocked(root, binding, preparationRunPredecessor(run), {
      type: "phase-progressed", stateAfter: "running",
      payload: { kind: "phase", phaseInstanceId: gate.phaseInstanceId, phaseState: "succeeded" },
      actor: { id: actor.id, surface: actor.surface }, at,
    }, gateSummaryProjector(gate, "succeeded"));
    return { status: "moved", run: next };
  });
}

/** The gate phase's summary in one instance state (created on block, settled on resume). */
function gatePhaseSummary(gate: GatePhaseV1, state: PhaseInstanceState): PhaseSummaryV1 {
  return {
    phaseInstanceId: gate.phaseInstanceId, logicalPhaseId: gate.logicalPhaseId, state,
    disposition: gate.disposition, attemptCount: 0, invocationCount: 0, brokerRequestCount: 0, effectCount: 0,
  };
}

/** A projector that upserts the gate phase summary at one instance state. */
function gateSummaryProjector(gate: GatePhaseV1, state: PhaseInstanceState): PreparationRunContentProjector {
  return (content) => ({
    ...content, phaseSummaries: upsertPhaseSummary(content.phaseSummaries, gatePhaseSummary(gate, state)),
  });
}

/** Acquire the ordinary lock, read the run, and hand it to one gate move. */
async function underGateLock(
  root: string, binding: PreparationRunBinding,
  move: (run: PreparationRunV1) => Promise<GateMoveV1>,
): Promise<GateMoveV1> {
  await acquireMutationLockBlocking(root, "ordinary");
  try {
    const read = await readPreparationRun(root, binding);
    if (read.status !== "ok") return { status: "refused", reason: `run unreadable: ${read.status}` };
    return await move(read.run);
  } finally {
    await releaseLock(root);
  }
}
