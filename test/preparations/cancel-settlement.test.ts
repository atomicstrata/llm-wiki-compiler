/**
 * @file test/preparations/cancel-settlement.test.ts
 * @description Cancellation settlement to an honest terminal (design section
 * 23.2). Every pending state here is produced by REAL production writers — a real
 * lock-free `.cancel` request driving a real `executePhaseAttempt` — never a
 * planted record. It proves a provably effect-free cancel reaches the `cancelled`
 * terminal and drops the consumed advisory; that terminal is genuinely terminal
 * while the store stays readable and usable; an effect-CAPABLE plan with no
 * durable effect evidence refuses to claim clean cancellation and is left
 * recoverable; an in-flight execution owner blocks settlement; and the two-append
 * `cancelling -> terminal` sequence is re-drivable after an interruption between
 * its halves.
 */

import { afterEach, describe, expect, it } from "vitest";
import { readPreparationCancel } from "../../src/preparations/cancellation.js";
import { executePhaseAttempt } from "../../src/preparations/attempts/execute.js";
import {
  recordDurableCancellingLocked, settleAttemptCancellationLocked, settleCancelledRunLocked,
  type CancelSettlementOutcomeV1,
} from "../../src/preparations/attempts/cancel-settlement.js";
import { attemptRequest, phaseInstanceIdFor, stagePreparation, succeededLeg, type StagedPreparation } from "./attempt-fixture.js";
import { externalEffectPlan } from "./store-fixture.js";
import {
  attemptSiblingPhase, readRun, requestCancel, settlementInput, settlementProbeLeg, underLock,
} from "./cancel-settlement-fixture.js";

const DECLARED_EFFECT = `sha256:${"a".repeat(64)}`;

/** A leg that must never run: proves the pre-launch cancel short-circuited it. */
const unreachableLeg = async () => { throw new Error("leg must not run after a durable cancel"); };

/** A leg that cancels MID-FLIGHT: the request lands after the launch boundary. */
function midFlightCancelLeg(staged: () => StagedPreparation) {
  return async () => {
    await requestCancel(staged());
    return { ...succeededLeg(), phaseState: "cancelled" as const };
  };
}

describe("cancellation settlement", () => {
  let staged: StagedPreparation | undefined;
  afterEach(async () => { await staged?.cleanup(); staged = undefined; });

  it("settles a provably effect-free cancelled run to the cancelled terminal", async () => {
    staged = await stagePreparation();
    await requestCancel(staged);
    const outcome = await executePhaseAttempt(attemptRequest(staged, { leg: unreachableLeg }));
    expect(outcome).toMatchObject({ status: "committed", phaseState: "cancelled" });
    const run = await readRun(staged);
    expect(run.state).toBe("cancelled");
    expect(run.transitions.at(-1)?.type).toBe("cancelled");
    expect(run.transitions.at(-2)?.type).toBe("cancelling");
    const advisory = await readPreparationCancel(staged.root, staged.binding.workspaceId, staged.binding.runId);
    expect(advisory).toEqual({ status: "absent" });
  });

  it("leaves the terminal genuinely terminal and the store still usable", async () => {
    staged = await stagePreparation();
    await requestCancel(staged);
    await executePhaseAttempt(attemptRequest(staged, { leg: unreachableLeg }));
    const settled = await readRun(staged);
    expect(settled.state).toBe("cancelled");
    const sibling = await attemptSiblingPhase(staged);
    expect(sibling).toMatchObject({ status: "parked", reason: "run-not-startable-cancelled" });
    expect(await readRun(staged)).toEqual(settled);
  });

  it("re-drives an already-terminal run without appending a second terminal", async () => {
    staged = await stagePreparation();
    await requestCancel(staged);
    await executePhaseAttempt(attemptRequest(staged, { leg: unreachableLeg }));
    const settled = await readRun(staged);
    const again = await settleCancelledRunLocked(settlementInput(staged));
    expect(again).toEqual({ status: "settled", state: "cancelled" });
    expect((await readRun(staged)).stateVersion).toBe(settled.stateVersion);
  });

  it("re-drives the settlement after an interruption between its two appends", async () => {
    staged = await stagePreparation();
    await executePhaseAttempt(attemptRequest(staged));
    await requestCancel(staged);
    // The real first append, alone: exactly the state a crash between the durable
    // `cancelling` record and the terminal leaves behind.
    await underLock(staged.root, () => recordDurableCancellingLocked(settlementInput(staged!)));
    expect((await readRun(staged)).state).toBe("cancelling");
    expect(await settleCancelledRunLocked(settlementInput(staged, "2026-07-22T00:02:00.000Z")))
      .toEqual({ status: "settled", state: "cancelled" });
    expect((await readRun(staged)).state).toBe("cancelled");
  });

  it("never claims clean cancellation when the plan can mutate and evidence is absent", async () => {
    staged = await stagePreparation(externalEffectPlan(DECLARED_EFFECT));
    const outcome = await executePhaseAttempt(attemptRequest(staged, { leg: midFlightCancelLeg(() => staged!) }));
    expect(outcome).toMatchObject({ status: "parked", reason: "cancel-effect-uncertain" });
    expect((await readRun(staged)).state).toBe("recovery-required");
    expect(await settleCancelledRunLocked(settlementInput(staged)))
      .toEqual({ status: "blocked", reason: "effect-freeness-unproven" });
    expect((await readRun(staged)).state).toBe("recovery-required");
  });

  it("keeps the unhonored advisory in place when the terminal is not provable", async () => {
    staged = await stagePreparation(externalEffectPlan(DECLARED_EFFECT));
    await executePhaseAttempt(attemptRequest(staged, { leg: midFlightCancelLeg(() => staged!) }));
    const advisory = await readPreparationCancel(staged.root, staged.binding.workspaceId, staged.binding.runId);
    expect(advisory.status).toBe("present");
  });

  it("blocks settlement while an execution owner still fences an in-flight attempt", async () => {
    staged = await stagePreparation();
    const probe = settlementProbeLeg(() => staged!);
    await executePhaseAttempt(attemptRequest(staged, { leg: probe.leg }));
    expect(probe.observed.outcome).toEqual({ status: "blocked", reason: "execution-owner-in-flight" });
  });

  // The advisory is consumed only by an append that HAPPENED. A cancelled phase
  // whose run is no longer `running` records nothing, and keying removal on the
  // attempt to record rather than the record itself dropped the operator's
  // request with its intent held nowhere — neither as `cancelling` nor as a
  // terminal — leaving a cancel that can never be honored or even observed.
  it("keeps the advisory when the durable cancelling record was never appended", async () => {
    staged = await stagePreparation();
    await requestCancel(staged);
    // Nothing was delivered mid-flight, so the advisory re-read is what finds this
    // request. The run is still `planned`, so the `cancelling` append refuses and
    // the settlement refuses — nothing durable captured the operator's intent, and
    // consuming the request here would leave it held nowhere at all.
    await underLock(staged.root, () => settleAttemptCancellationLocked(attemptRequest(staged!), false));
    expect((await readRun(staged)).state).toBe("planned");
    const advisory = await readPreparationCancel(staged.root, staged.binding.workspaceId, staged.binding.runId);
    expect(advisory.status).toBe("present");
  });

  // The other half of the union: a request that arrives AFTER the executor
  // delivered anything. The leg writes it and returns immediately, well inside
  // the bounded poll interval, so nothing was delivered and only the commit-time
  // re-read can see it. Dropping that re-read would silently ignore every cancel
  // that lands late.
  it("honors a cancel that arrived too late for the executor to deliver", async () => {
    staged = await stagePreparation();
    const previous = process.env.LLMWIKI_PREP_CANCEL_POLL_INTERVAL_MS;
    // PIN the precondition rather than race it: with the poll interval beyond the
    // leg's lifetime, the poll provably cannot tick, so nothing is delivered and
    // the commit-time re-read is the only thing that can find this request.
    process.env.LLMWIKI_PREP_CANCEL_POLL_INTERVAL_MS = "600000";
    try {
      const leg = async () => {
        await requestCancel(staged!);
        return { ...succeededLeg(), phaseState: "cancelled" as const };
      };
      expect(await executePhaseAttempt(attemptRequest(staged, { leg })))
        .toMatchObject({ status: "committed", phaseState: "cancelled" });
      expect((await readRun(staged)).state).toBe("cancelled");
    } finally {
      if (previous === undefined) delete process.env.LLMWIKI_PREP_CANCEL_POLL_INTERVAL_MS;
      else process.env.LLMWIKI_PREP_CANCEL_POLL_INTERVAL_MS = previous;
    }
  });

  it("refuses to settle a run that never entered a cancellation state", async () => {
    staged = await stagePreparation();
    await executePhaseAttempt(attemptRequest(staged));
    expect(await settleCancelledRunLocked(settlementInput(staged)))
      .toEqual({ status: "blocked", reason: "run-not-cancellable-running" });
  });
});
