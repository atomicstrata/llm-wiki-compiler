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
 *
 * ONE BODY EACH over {@link GateDriverSteps}, none of which takes a project
 * root: {@link blockAtGateWith} and {@link resumeFromGateWith} decide under the
 * lock (the read, the state and proceed checks, the projected append). The
 * blocking lock is the one MECHANISM the steps carry. The root forms keep their
 * signatures and pass {@link diskGateDriverSteps}, which calls the incumbent lock,
 * reader and writer when asked; {@link gateDriverStepsOver} composes the read and
 * the append from each one's own body, with the caller's lock.
 */

import { acquireMutationLockBlocking } from "../operation-bundles/lock-gate.js";
import { releaseLock } from "../utils/lock.js";
import type { Sha256Digest } from "../capability-providers/types.js";
import { upsertPhaseSummary } from "./attempts/start.js";
import { findApprovedGateProof } from "./gates.js";
import { preparationRunPredecessor } from "./run-integrity.js";
import {
  appendPreparationTransitionWith, appendProjectedTransitionLocked, preparationRunHolds, readPreparationRun, readPreparationRunFrom,
  type PreparationRunContentProjector, type PreparationRunLeafReads, type PreparationRunRead, type PreparationRunWriteSteps,
} from "./run-store.js";
import type { PhaseInstanceId } from "./ids.js";
import type {
  AppendPreparationTransitionInput, PhaseInstanceState, PhaseSummaryV1,
  PreparationPrincipalV1, PreparationRunBinding, PreparationRunPredecessor, PreparationRunV1,
} from "./run-types.js";

/** One projected append fenced to `expected`, under a held lock. Shared by the gate driver and the gate operation. */
export type ProjectedRunAppend = (
  binding: PreparationRunBinding, expected: PreparationRunPredecessor,
  input: AppendPreparationTransitionInput, project: PreparationRunContentProjector,
) => Promise<PreparationRunV1>;

/** What one gate move asks for, in order. No member takes a project root. */
export interface GateDriverSteps {
  /** The blocking project lock: a MECHANISM, no decision. */
  readonly lock: { acquire(): Promise<void>; release(): Promise<void> };
  /** The run at `binding`, authenticated. */
  readRun(binding: PreparationRunBinding): Promise<PreparationRunRead>;
  /** The projected append. */
  readonly appendProjected: ProjectedRunAppend;
}

/**
 * LOCAL DISK. The incumbent ordinary blocking lock, run reader and projected
 * writer for `root`, each called when asked. The run read and the append's reads
 * are ONE HOLD's (`preparationRunHolds`): a new hold begins when the lock is
 * acquired, and the append, the one run write, ends it. Shared with
 * finalization, which reads and appends under the same lock the same way.
 */
export function diskGateDriverSteps(root: string): GateDriverSteps {
  const holds = preparationRunHolds(root);
  return {
    lock: {
      acquire: async () => { await acquireMutationLockBlocking(root, "ordinary"); holds.renew(); },
      release: () => releaseLock(root),
    },
    readRun: (binding) => readPreparationRun(root, binding, holds.current()),
    appendProjected: (binding, expected, input, project) =>
      holds.writing((hold) => appendProjectedTransitionLocked(root, binding, expected, input, project, hold)),
  };
}

/** The same read and append over the run store's own bodies, under the caller's `lock`. Building it does no I/O. */
export function gateDriverStepsOver(
  sources: { runs: PreparationRunLeafReads; writes: PreparationRunWriteSteps }, lock: GateDriverSteps["lock"],
): GateDriverSteps {
  return {
    lock,
    readRun: (binding) => readPreparationRunFrom(sources.runs, binding),
    appendProjected: (binding, expected, input, project) => appendPreparationTransitionWith(sources.writes, binding, expected, input, project),
  };
}

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
  return blockAtGateWith(diskGateDriverSteps(root), binding, gate, actor, at);
}

/** {@link blockAtGate} over {@link GateDriverSteps}: THE ONE BODY. */
export async function blockAtGateWith(
  steps: GateDriverSteps, binding: PreparationRunBinding, gate: GatePhaseV1,
  actor: PreparationPrincipalV1, at: string,
): Promise<GateMoveV1> {
  return underGateLock(steps, binding, async (run) => {
    if (!BLOCKABLE_STATES.has(run.state)) return { status: "refused", reason: `run is ${run.state}, not running` };
    const next = await steps.appendProjected(binding, preparationRunPredecessor(run), {
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
  return resumeFromGateWith(diskGateDriverSteps(root), binding, gate, actor, at);
}

/** {@link resumeFromGate} over {@link GateDriverSteps}: THE ONE BODY. */
export async function resumeFromGateWith(
  steps: GateDriverSteps, binding: PreparationRunBinding, gate: GatePhaseV1,
  actor: PreparationPrincipalV1, at: string,
): Promise<GateMoveV1> {
  return underGateLock(steps, binding, async (run) => {
    if (run.state !== "awaiting-gate") return { status: "refused", reason: `run is ${run.state}, not awaiting-gate` };
    if (!hasProceedDecision(run, gate)) {
      return { status: "refused", reason: `gate ${gate.gateId} has no operative approval` };
    }
    const next = await steps.appendProjected(binding, preparationRunPredecessor(run), {
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
  steps: GateDriverSteps, binding: PreparationRunBinding,
  move: (run: PreparationRunV1) => Promise<GateMoveV1>,
): Promise<GateMoveV1> {
  await steps.lock.acquire();
  try {
    const read = await steps.readRun(binding);
    if (read.status !== "ok") return { status: "refused", reason: `run unreadable: ${read.status}` };
    return await move(read.run);
  } finally {
    await steps.lock.release();
  }
}
