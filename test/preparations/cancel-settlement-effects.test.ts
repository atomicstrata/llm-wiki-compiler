/**
 * @file test/preparations/cancel-settlement-effects.test.ts
 * @description The carried-forward `cancelled-with-effects` settlement (design
 * section 23.2: "known applied effects produce `cancelled-with-effects`", "an
 * unknown effect produces `recovery-required`"). A possibly-applied mid-flight
 * cancel used to fail closed to `recovery-required` with no way out; here the
 * durable ledger decides.
 *
 * The applied effect is produced by the REAL governed effect path — an approved
 * `confirm-external-effect` gate, an approved `confirm-residual-risk` gate, a
 * durable `recordEffectStartLocked`, and a host-minted receipt committed through
 * `commitEffectReceiptLocked` — running inside the attempt leg with the project
 * lock released, exactly as production does. Nothing here is planted.
 */

import { afterEach, describe, expect, it } from "vitest";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { mintExternalEffectReceipt, type ExternalEffectReceiptV1 } from "../../src/capability-providers/brokers/receipts.js";
import { authorGateProof } from "../../src/preparations/gates.js";
import {
  commitEffectReceiptLocked, effectPlanEntryDigest, recordEffectStartLocked,
  type EffectStartContext, type PreparationEffectPlanV1,
} from "../../src/preparations/effects.js";
import { preparationRunPredecessor } from "../../src/preparations/run-integrity.js";
import { appendPreparationTransitionLocked, appendProjectedTransitionLocked } from "../../src/preparations/run-store.js";
import { executePhaseAttempt } from "../../src/preparations/attempts/execute.js";
import { runPreparation } from "../../src/index.js";
import type { RunPreparationInputV1 } from "../../src/preparations/runner.js";
import {
  settleCancelledRunLocked, type CancelSettlementOutcomeV1,
} from "../../src/preparations/attempts/cancel-settlement.js";
import { acquireMutationLockBlocking } from "../../src/operation-bundles/lock-gate.js";
import { releaseLock } from "../../src/utils/lock.js";
import type { AttemptId, PhaseInstanceId } from "../../src/preparations/ids.js";
import type { NormalizedPreparationPlanV1, PhaseGateKind } from "../../src/preparations/plan-types.js";
import type { PreparationPrincipal } from "../../src/preparations/principals.js";
import { attemptRequest, phaseInstanceIdFor, stagePreparation, succeededLeg, type StagedPreparation } from "./attempt-fixture.js";
import { externalEffectPlan } from "./store-fixture.js";
import {
  OPERATOR, attemptSiblingPhase, readRun, requestCancel, settlementInput, settlementProbeLeg, underLock,
} from "./cancel-settlement-fixture.js";

const DIGEST = parseSha256Digest(`sha256:${"a".repeat(64)}`);
const AT = "2026-07-22T00:00:00.000Z";
const OPERATOR_PRINCIPAL: PreparationPrincipal = { id: "operator", surface: "cli", grants: [] };

/** The one declared mutating effect the fixture plan binds its `collect` phase to. */
const EFFECT_PLAN: PreparationEffectPlanV1 = {
  schemaVersion: 1, effectClass: "email.send", targetIdentity: "mailbox:ops", providerPinDigest: DIGEST,
  grantSnapshotDigest: DIGEST, brokerId: "email", brokerContractVersion: "1.0.0", invocationId: "inv-1",
  idempotencyKey: "idem-1", requestDigest: DIGEST, rollbackSemantics: "none",
};
const EFFECT_ENTRY = effectPlanEntryDigest(EFFECT_PLAN);

/** Approve one gate over the AUTHENTICATED plan and persist its full proof. */
async function approveGate(
  staged: StagedPreparation, plan: NormalizedPreparationPlanV1, phaseInstanceId: PhaseInstanceId,
  gateId: string, gateKind: PhaseGateKind, decisionIndex: number,
): Promise<void> {
  const authored = authorGateProof({
    principal: OPERATOR_PRINCIPAL, choice: "approved", decisionIndex, at: AT,
    authoritative: {
      runId: staged.binding.runId, plan, gate: { gateId, gateKind }, phaseInstanceId,
      currentInput: plan.initialInputSet, currentEffectPlanDigest: EFFECT_ENTRY,
    },
  });
  await appendProjectedTransitionLocked(staged.root, staged.binding, preparationRunPredecessor(await readRun(staged)), {
    type: "gate-decided", stateAfter: "running", actor: OPERATOR, at: AT,
    payload: { kind: "gate", gateProofId: authored.summary.gateProofId, decision: "approved" },
  }, (next) => ({ ...next, gateProofs: [...next.gateProofs, authored.summary] }));
}

/** The two gate approvals every governed effect on the `collect` phase requires. */
async function approveEffectGates(
  staged: StagedPreparation, plan: NormalizedPreparationPlanV1, phaseInstanceId: PhaseInstanceId,
): Promise<void> {
  await approveGate(staged, plan, phaseInstanceId, "send", "confirm-external-effect", 0);
  await approveGate(staged, plan, phaseInstanceId, "risk", "confirm-residual-risk", 1);
}

/**
 * Mint the host receipt for one durable start. Every bound dimension is taken
 * from the START'S OWN claim facts rather than restated, so the receipt matches
 * the persisted claim digest by construction and the test cannot accidentally
 * drift into exercising the receipt-mismatch refusal instead of the settlement.
 */
function receiptFor(context: EffectStartContext, outcome: ExternalEffectReceiptV1["outcome"]): ExternalEffectReceiptV1 {
  const { schemaVersion: _version, ...claim } = context.claimFacts;
  return mintExternalEffectReceipt({
    ...claim, effectId: context.effectId, approvedRequestDigest: claim.requestDigest, outcome,
  });
}

/** The run/attempt coordinates every effect call for the live attempt shares. */
interface EffectCoordinates {
  root: string;
  binding: StagedPreparation["binding"];
  principal: PreparationPrincipal;
  at: string;
  phaseInstanceId: PhaseInstanceId;
  attemptId: AttemptId;
  leaseNonce: string;
  effectIndex: number;
}

/** Bind the effect coordinates to the run's CURRENT live execution owner. */
async function coordinates(
  staged: StagedPreparation, phaseInstanceId: PhaseInstanceId, effectIndex: number,
): Promise<EffectCoordinates> {
  const owner = (await readRun(staged)).executionOwner;
  if (owner === undefined) throw new Error("the live attempt must own the run");
  return {
    root: staged.root, binding: staged.binding, principal: OPERATOR_PRINCIPAL, at: AT, phaseInstanceId,
    attemptId: owner.attemptId, leaseNonce: owner.leaseNonce, effectIndex,
  };
}

/** Record ONE durable effect start for the live attempt, leaving it uncommitted. */
async function startEffect(
  staged: StagedPreparation, plan: NormalizedPreparationPlanV1, at: EffectCoordinates,
): Promise<EffectStartContext> {
  const started = await recordEffectStartLocked({
    ...at, brokerRequestIndex: at.effectIndex, externalEffectGateId: "send",
    effectPlan: EFFECT_PLAN, currentInputDigest: plan.initialInputSet.digest,
  });
  return started.context;
}

/** Record a durable effect start and commit its host receipt for the live attempt. */
async function driveEffect(
  staged: StagedPreparation, plan: NormalizedPreparationPlanV1, phaseInstanceId: PhaseInstanceId,
  outcome: ExternalEffectReceiptV1["outcome"],
): Promise<void> {
  const at = await coordinates(staged, phaseInstanceId, 0);
  const context = await startEffect(staged, plan, at);
  await commitEffectReceiptLocked({ ...at, context, receipt: receiptFor(context, outcome) });
}

/**
 * A leg that governs one real external effect, optionally records extra durable
 * effect state, then observes an operator cancel — all with the project lock
 * reacquired by the leg itself, exactly as production effect work does.
 */
function effectThenCancelLeg(
  staged: () => StagedPreparation, plan: NormalizedPreparationPlanV1, outcome: ExternalEffectReceiptV1["outcome"],
  options: { extra?: (at: EffectCoordinates) => Promise<void>; advisory?: boolean } = {},
) {
  return async () => {
    const phaseInstanceId = phaseInstanceIdFor(staged().binding, "collect");
    await underLock(staged().root, async () => {
      await approveEffectGates(staged(), plan, phaseInstanceId);
      await driveEffect(staged(), plan, phaseInstanceId, outcome);
      if (options.extra !== undefined) await options.extra(await coordinates(staged(), phaseInstanceId, 0));
      // Withholding the advisory leaves the attempt's own settlement inert, so
      // the run stays at the cancel park for the coordinator to find later.
      if (options.advisory !== false) await requestCancel(staged());
    });
    return { ...succeededLeg(), phaseState: "cancelled" as const };
  };
}

/** A runner input for a TERMINAL run — capabilities are captured but never invoked. */
function terminalRunnerInput(staged: StagedPreparation): RunPreparationInputV1 {
  return {
    root: staged.root, binding: staged.binding,
    legFor: () => { throw new Error("a terminal run drives no leg"); },
    authorityResolver: { resolve: async () => ({ status: "ok", extras: { inputExposureSetDigest: DIGEST, providerPinDigest: DIGEST } }) },
    adapters: new Map(),
    policyContract: { handlerId: "cancel", handlerContractVersion: "1.0.0", handlerContractDigest: DIGEST,
      exclusionReasonCodes: [], reconciliationReasonCodes: [], proposalKinds: [] },
    principal: OPERATOR, operationPrincipal: { id: "operator", surface: "cli", grants: ["operation-bundle.approve"] },
    handlerContractDigest: DIGEST, clock: { now: () => AT },
  } as unknown as RunPreparationInputV1;
}

/**
 * A runner input that DRIVES the collect phase's governed effect and then cancels
 * — the editorial remote-effect journey. The materializer is present so the
 * drive path is entered but is never consulted (the run terminates in the effect
 * leg, before materialization).
 */
function effectDrivingInput(
  staged: StagedPreparation, plan: NormalizedPreparationPlanV1, outcome: ExternalEffectReceiptV1["outcome"],
): RunPreparationInputV1 {
  return {
    root: staged.root, binding: staged.binding,
    materializer: { handlerContractDigest: DIGEST, materialize: () => { throw new Error("effect run cancels before materialize"); } },
    legFor: (logicalPhaseId: string) =>
      logicalPhaseId === "collect" ? effectThenCancelLeg(() => staged, plan, outcome) : async () => succeededLeg(),
    authorityResolver: { resolve: async () => ({ status: "ok", extras: { inputExposureSetDigest: DIGEST, providerPinDigest: DIGEST } }) },
    adapters: new Map(),
    policyContract: { handlerId: "editorial", handlerContractVersion: "1.0.0", handlerContractDigest: DIGEST,
      exclusionReasonCodes: [], reconciliationReasonCodes: [], proposalKinds: [] },
    principal: OPERATOR, operationPrincipal: { id: "operator", surface: "cli", grants: ["operation-bundle.approve"] },
    handlerContractDigest: DIGEST, clock: { now: () => AT },
  } as unknown as RunPreparationInputV1;
}

describe("the editorial remote-effect journey drives an effect through the runner (blocker #4)", () => {
  let staged: StagedPreparation | undefined;
  afterEach(async () => { await staged?.cleanup(); staged = undefined; });

  it("applies a governed external effect, cancels with residual state, and reaches cancelled-with-effects", async () => {
    const plan = externalEffectPlan(EFFECT_ENTRY, "risk", { withMaterialization: true });
    staged = await stagePreparation(plan);
    const input = effectDrivingInput(staged, plan, "applied");
    // runPreparation drives collect: approves the two effect gates, applies the
    // effect, and observes the cancel — the whole governed-effect protocol.
    await runPreparation(input);
    expect((await readRun(staged)).state).toBe("cancelled-with-effects");
    // The re-drive reads the durable terminal and reports the correct runner result.
    expect(await runPreparation(input)).toEqual({ status: "cancelled-with-effects", runId: staged.binding.runId });
  });

  it("routes an unknown-outcome effect to recovery-required, not a clean terminal", async () => {
    const plan = externalEffectPlan(EFFECT_ENTRY, "risk", { withMaterialization: true });
    staged = await stagePreparation(plan);
    await runPreparation(effectDrivingInput(staged, plan, "outcome-unknown"));
    // A possibly-applied effect whose outcome is unknown cannot cleanly cancel: the
    // run parks to recovery-required, and the runner reports no clean terminal.
    expect((await readRun(staged)).state).toBe("recovery-required");
    const result = await runPreparation(effectDrivingInput(staged, plan, "outcome-unknown"));
    expect(result.status).not.toBe("handed-off");
    expect(result.status).not.toBe("cancelled-with-effects");
  });
});

describe("cancellation settlement with external effects", () => {
  let staged: StagedPreparation | undefined;
  const plan = externalEffectPlan(EFFECT_ENTRY);
  afterEach(async () => { await staged?.cleanup(); staged = undefined; });

  it("settles a cancel-interrupted run with a durably applied effect to cancelled-with-effects", async () => {
    staged = await stagePreparation(plan);
    const outcome = await executePhaseAttempt(attemptRequest(staged, { leg: effectThenCancelLeg(() => staged!, plan, "applied") }));
    expect(outcome).toMatchObject({ status: "parked", reason: "cancel-effect-uncertain" });
    const run = await readRun(staged);
    expect(run.state).toBe("cancelled-with-effects");
    expect(run.effectSummaries[0]?.outcome).toBe("applied");
    expect(run.brokerRequestSummaries[0]?.state).toBe("settled");
  });

  it("runPreparation surfaces a cancelled-with-effects run as its OWN result (unit F)", async () => {
    staged = await stagePreparation(plan);
    await executePhaseAttempt(attemptRequest(staged, { leg: effectThenCancelLeg(() => staged!, plan, "applied") }));
    expect((await readRun(staged)).state).toBe("cancelled-with-effects");
    // The plan declares no materialization triple; the terminal result must still
    // surface (F reordered the terminal classification before the limits check).
    const result = await runPreparation(terminalRunnerInput(staged));
    expect(result).toEqual({ status: "cancelled-with-effects", runId: staged.binding.runId });
  });

  it("leaves the cancelled-with-effects terminal terminal and the run readable", async () => {
    staged = await stagePreparation(plan);
    await executePhaseAttempt(attemptRequest(staged, { leg: effectThenCancelLeg(() => staged!, plan, "applied") }));
    const settled = await readRun(staged);
    const sibling = await attemptSiblingPhase(staged);
    expect(sibling).toMatchObject({ status: "parked", reason: "run-not-startable-cancelled-with-effects" });
    expect(await settleCancelledRunLocked(settlementInput(staged))).toEqual({ status: "settled", state: "cancelled-with-effects" });
    expect((await readRun(staged)).stateVersion).toBe(settled.stateVersion);
  });

  it("holds an unknown-outcome effect at recovery-required rather than any cancel terminal", async () => {
    staged = await stagePreparation(plan);
    await executePhaseAttempt(attemptRequest(staged, { leg: effectThenCancelLeg(() => staged!, plan, "outcome-unknown") }));
    const run = await readRun(staged);
    expect(run.state).toBe("recovery-required");
    expect(run.effectSummaries[0]?.outcome).toBe("outcome-unknown");
    expect(await settleCancelledRunLocked(settlementInput(staged))).toEqual({ status: "blocked", reason: "unresolved-effect" });
    expect((await readRun(staged)).state).toBe("recovery-required");
  });

  it("refuses to settle beside a durably started, unreceipted effect", async () => {
    staged = await stagePreparation(plan);
    const leg = effectThenCancelLeg(() => staged!, plan, "applied", { extra: async (at) => {
      // A second effect whose broker call was reached but never receipted: the
      // real durable start, left exactly as a crash mid-call leaves it.
      await startEffect(staged!, plan, { ...at, effectIndex: 1 });
    } });
    await executePhaseAttempt(attemptRequest(staged, { leg }));
    const run = await readRun(staged);
    expect(run.effectSummaries.map((effect) => effect.outcome)).toEqual(["applied", "started"]);
    expect(await settleCancelledRunLocked(settlementInput(staged))).toEqual({ status: "blocked", reason: "unresolved-effect" });
    expect(run.state).toBe("recovery-required");
  });

  // The broker's idempotency replay: a retried request the broker recognises as
  // already performed. It is an APPLIED mutation with a different label, and a
  // terminal that ignored it would report a run that mutated the world as
  // cleanly cancelled.
  it("settles an already-applied idempotency replay to cancelled-with-effects", async () => {
    staged = await stagePreparation(plan);
    await executePhaseAttempt(attemptRequest(staged, { leg: effectThenCancelLeg(() => staged!, plan, "already-applied") }));
    const run = await readRun(staged);
    expect(run.effectSummaries[0]?.outcome).toBe("already-applied");
    expect(run.state).toBe("cancelled-with-effects");
  });

  /**
   * Park a run at a GENUINE cancel park: one real applied effect, then a
   * mid-flight cancel with no advisory, so the attempt's own settlement stays
   * inert and the run rests at the park for a later sweep to find.
   */
  async function parkAtCancelWithAppliedEffect(): Promise<void> {
    staged = await stagePreparation(plan);
    const leg = effectThenCancelLeg(() => staged!, plan, "applied", { advisory: false });
    expect(await executePhaseAttempt(attemptRequest(staged, { leg })))
      .toMatchObject({ status: "parked", reason: "cancel-effect-uncertain" });
    expect((await readRun(staged)).state).toBe("recovery-required");
  }

  /** Request the operator cancel, then drive one REAL gated acquisition. */
  async function requestThenSweep(): Promise<void> {
    await requestCancel(staged!);
    await acquireMutationLockBlocking(staged!.root, "ordinary");
    await releaseLock(staged!.root);
  }

  /**
   * Stage a run, govern one effect inside a live attempt, and report what the
   * settlement decides WHILE that attempt still owns the run. `governEffect`
   * chooses which ledger the classifier will be looking at.
   */
  async function observeSettlementMidAttempt(
    governEffect: (phaseInstanceId: PhaseInstanceId) => Promise<void>,
  ): Promise<CancelSettlementOutcomeV1 | undefined> {
    staged = await stagePreparation(plan);
    const probe = settlementProbeLeg(() => staged!, async () => {
      const phaseInstanceId = phaseInstanceIdFor(staged!.binding, "collect");
      await approveEffectGates(staged!, plan, phaseInstanceId);
      await governEffect(phaseInstanceId);
      await requestCancel(staged!);
    });
    await executePhaseAttempt(attemptRequest(staged, { leg: probe.leg }));
    return probe.observed.outcome;
  }

  it("blocks a live execution owner even once the ledger already proves an applied effect", async () => {
    const observed = await observeSettlementMidAttempt((phase) => driveEffect(staged!, plan, phase, "applied"));
    expect(observed).toEqual({ status: "blocked", reason: "execution-owner-in-flight" });
  });

  // THE ORDERING ITSELF, which the applied-effect case above cannot witness: with
  // a resolved ledger both an owner-first and an owner-second classifier answer
  // `blocked`, just for different reasons. Only an UNRESOLVED ledger separates
  // them — an owner-second classifier reports the ledger and never mentions the
  // live attempt. The owner must dominate, because a run whose attempt is still
  // in flight can acquire more effects after any classification, so a terminal
  // decided on the ledger seen mid-flight strands the receipt commit that follows.
  it("names the live execution owner, not the ledger, when both would block", async () => {
    // A durable start with no receipt: an effect the broker was asked for and
    // whose outcome is unknown, so the ledger is genuinely unresolved.
    const observed = await observeSettlementMidAttempt(async (phase) => {
      await startEffect(staged!, plan, await coordinates(staged!, phase, 0));
    });
    expect(observed).toEqual({ status: "blocked", reason: "execution-owner-in-flight" });
  });

  // The cancel park the coordinator was built for: an attempt that could not
  // prove effect-freeness, whose operator cancel arrives after the attempt is
  // gone. The park's own recorded code is what authorizes advancing it.
  it("settles a genuine cancel park to cancelled-with-effects on a gated acquisition", async () => {
    await parkAtCancelWithAppliedEffect();
    await requestThenSweep();
    expect((await readRun(staged!)).state).toBe("cancelled-with-effects");
  });

  // The park's own code is read from the transition that PRODUCED the current
  // state, found by scanning back past records that changed nothing. A
  // `notice-recorded` is legal from any state and is exactly such a record, so
  // reading the LAST transition instead would let one informational notice make a
  // genuine cancel park unrecognisable — blocking a settlement that has its proof,
  // permanently and for a reason unrelated to any evidence.
  it("reads the park through a later notice that changed no state", async () => {
    await parkAtCancelWithAppliedEffect();
    await underLock(staged!.root, async () => {
      await appendPreparationTransitionLocked(staged!.root, staged!.binding, preparationRunPredecessor(await readRun(staged!)), {
        type: "notice-recorded", stateAfter: "recovery-required", actor: OPERATOR,
        at: "2026-07-22T00:05:00.000Z", payload: { kind: "notice", code: "cancellation-observed" },
      });
    });
    await requestThenSweep();
    expect((await readRun(staged!)).state).toBe("cancelled-with-effects");
  });

  it("holds a refused effect at recovery-required: a mutating plan is never cleanly cancelled", async () => {
    staged = await stagePreparation(plan);
    await executePhaseAttempt(attemptRequest(staged, { leg: effectThenCancelLeg(() => staged!, plan, "refused") }));
    const run = await readRun(staged);
    expect(run.effectSummaries[0]?.outcome).toBe("refused");
    expect(await settleCancelledRunLocked(settlementInput(staged))).toEqual({ status: "blocked", reason: "effect-freeness-unproven" });
    expect(run.state).toBe("recovery-required");
  });
});
