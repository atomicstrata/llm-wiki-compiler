/**
 * @file test/preparations/cancel-delivery.test.ts
 * @description In-flight cancellation DELIVERY (design section 23.2). It proves
 * the executor owns a cancellation signal, polls the advisory `.cancel` file
 * DURING the leg, and trips the signal so a cancel written mid-leg actually stops
 * the running leg — the attempt settles `cancelled` and the effect-free run
 * settles its `cancelled` terminal (NOT `succeeded`). A mid-flight cancel of an
 * effect-capable phase fails closed
 * to `recovery-required` (a possibly-applied effect must never read as a false
 * cancelled). The provider leg wires the executor-owned signal into its Provider
 * V2 invocation, so cooperative cancel and forced backend termination reach the
 * backend.
 */

import { afterEach, describe, expect, it } from "vitest";
import { readPreparationRun } from "../../src/preparations/run-store.js";
import { removePreparationCancelLocked, writePreparationCancelLockFree } from "../../src/preparations/cancellation.js";
import { executePhaseAttempt } from "../../src/preparations/attempts/execute.js";
import { providerLegRunner, type ProviderInvokeFn } from "../../src/preparations/attempts/provider.js";
import {
  EXPOSURE, PIN, attemptRequest, phaseInstanceIdFor, providerRequest, stagePreparation, succeededLeg,
  wideBounds, type StagedPreparation,
} from "./attempt-fixture.js";
import { fixturePlan } from "./store-fixture.js";
import { attemptSiblingPhase } from "./cancel-settlement-fixture.js";
import type { AttemptLegContextV1, AttemptOutcomeV1 } from "../../src/preparations/attempts/types.js";

const NONCE = "0".repeat(32);
const cancelInput = (staged: StagedPreparation) => ({ workspaceId: staged.binding.workspaceId, runId: staged.binding.runId, requester: "op", at: "2026-07-22T00:00:00.000Z", nonce: NONCE });

/** Stage a preparation whose `collect` phase can mutate (effects capable). */
function stageEffectCapable(): Promise<StagedPreparation> {
  return stagePreparation(fixturePlan((plan) => {
    (plan as { bounds: Record<string, number> }).bounds.maximumEffects = 4;
    (plan as { bounds: Record<string, number> }).bounds.maximumBrokerRequests = 4;
    for (const phase of plan.phases as Array<{ logicalPhaseId: string; bounds: Record<string, number> }>) {
      if (phase.logicalPhaseId === "collect") { phase.bounds.maximumEffectsPerAttempt = 1; phase.bounds.maximumBrokerRequestsPerAttempt = 1; }
    }
  }));
}

/**
 * Deliver a REAL mid-flight cancel, then retract the advisory before the commit
 * re-reads it — a concurrent cleanup, or an operator changing their mind inside
 * the window between delivery and settlement. The returned attempt is still in
 * flight; await it for the outcome.
 */
function deliverThenRetract(staged: StagedPreparation): Promise<AttemptOutcomeV1> {
  let legStarted!: () => void;
  const started = new Promise<void>((resolve) => { legStarted = resolve; });
  const leg = async (ctx: AttemptLegContextV1) => {
    legStarted();
    await new Promise<void>((resolve) => {
      if (ctx.cancelSignal?.aborted) resolve();
      else ctx.cancelSignal?.addEventListener("abort", () => resolve(), { once: true });
    });
    await removePreparationCancelLocked(staged.root, staged.binding.workspaceId, staged.binding.runId);
    return { ...succeededLeg(), phaseState: "cancelled" as const };
  };
  const attempt = executePhaseAttempt(attemptRequest(staged, { leg }));
  return started.then(async () => {
    await writePreparationCancelLockFree(staged.root, cancelInput(staged));
    return attempt;
  });
}

/** A leg that blocks until the executor-owned cancel signal trips, then cancels. */
const signalAwareLeg = async (ctx: AttemptLegContextV1) => {
  await new Promise<void>((resolve) => {
    if (ctx.cancelSignal?.aborted) resolve();
    else ctx.cancelSignal?.addEventListener("abort", () => resolve(), { once: true });
  });
  return { ...succeededLeg(), phaseState: "cancelled" as const };
};

describe("in-flight cancellation delivery", () => {
  let staged: StagedPreparation | undefined;
  afterEach(async () => { await staged?.cleanup(); staged = undefined; });

  it("delivers a mid-leg cancel to the running leg and settles the cancelled terminal", async () => {
    staged = await stagePreparation();
    let legStarted!: () => void;
    const started = new Promise<void>((resolve) => { legStarted = resolve; });
    const leg = (ctx: AttemptLegContextV1) => { legStarted(); return signalAwareLeg(ctx); };
    const attempt = executePhaseAttempt(attemptRequest(staged, { leg }));
    await started;
    await writePreparationCancelLockFree(staged.root, cancelInput(staged));
    expect(await attempt).toMatchObject({ status: "committed", phaseState: "cancelled" });
    // The plan declares no mutating effect, so the run does not stop at the
    // `cancelling` acknowledgement: it settles its honest `cancelled` terminal.
    expect(await readRunState(staged)).toBe("cancelled");
  });

  it("bounds a hung leg that ignores a delivered cancel and settles recovery-required without hanging", async () => {
    staged = await stagePreparation();
    const previous = process.env.LLMWIKI_PREP_CANCEL_DEADLINE_MS;
    process.env.LLMWIKI_PREP_CANCEL_DEADLINE_MS = "50";
    try {
      // Gate on the leg actually starting so the cancel is written AFTER the
      // pre-launch check passed — this exercises the mid-flight hung-leg deadline,
      // never the (load-dependent) pre-launch cancel path.
      let legStarted!: () => void;
      const started = new Promise<void>((resolve) => { legStarted = resolve; });
      const hungLeg = () => { legStarted(); return new Promise<never>(() => {}); };
      const attempt = executePhaseAttempt(attemptRequest(staged, { leg: hungLeg }));
      await started;
      await writePreparationCancelLockFree(staged.root, cancelInput(staged));
      expect(await attempt).toMatchObject({ status: "committed", phaseState: "recovery-required" });
      // The deadline only arms AFTER delivery, so a cancel provably reached this
      // attempt. The run must record it whatever the phase settled as — leaving it
      // `running` here is what let a sibling phase run to completion behind a
      // delivered cancel.
      expect(await readRunState(staged)).toBe("cancelled");
    } finally {
      if (previous === undefined) delete process.env.LLMWIKI_PREP_CANCEL_DEADLINE_MS;
      else process.env.LLMWIKI_PREP_CANCEL_DEADLINE_MS = previous;
    }
  });

  it("fails closed to recovery-required when a mid-flight cancel hits an effect-capable phase", async () => {
    staged = await stageEffectCapable();
    // The advisory has to be REAL and present, or the settlement that runs right
    // after the park never executes and this witnesses only half the path. The
    // fixture's phase is effect-capable by BUDGET with no declared effect plan,
    // which is exactly the shape a digest-only effect-freeness proof called safe
    // — it overwrote this park with a clean `cancelled` terminal.
    const cancelledLeg = async () => {
      await writePreparationCancelLockFree(staged!.root, cancelInput(staged!));
      return { ...succeededLeg(), phaseState: "cancelled" as const, invocationCount: 1 };
    };
    const outcome = await executePhaseAttempt(attemptRequest(staged, { leg: cancelledLeg }));
    expect(outcome).toMatchObject({ status: "parked", reason: "cancel-effect-uncertain" });
    expect(await readRunState(staged)).toBe("recovery-required");
  });

  // Delivery OBSERVED the cancellation — it fired the signal that stopped the leg.
  // Settlement used to re-derive that fact from the advisory FILE, so a request
  // that vanished between delivery and commit erased the observation: the phase
  // reported `cancelled` while the run stayed `running`, and cancellation was
  // not sticky at all.
  it("keeps a delivered cancellation sticky when the advisory vanishes before commit", async () => {
    staged = await stagePreparation();
    expect(await deliverThenRetract(staged)).toMatchObject({ status: "committed", phaseState: "cancelled" });
    expect(await readRunState(staged)).toBe("cancelled");
    // Sticky means a sibling phase cannot start behind it — the whole point of
    // capturing the cancellation durably rather than trusting the advisory.
    const sibling = await attemptSiblingPhase(staged);
    expect(sibling).toMatchObject({ status: "parked", reason: "run-not-startable-cancelled" });
  });

  // `aborted` is a PROTOTYPE GETTER, so an own property shadows it. The leg cannot
  // abort the executor's controller, but it could make the flag read true — and a
  // delivery record read off that flag is therefore a leg-supplied claim, not a
  // host observation. With no operator advisory anywhere, this must move nothing.
  it("ignores a leg that shadows the cancel signal's aborted flag", async () => {
    staged = await stagePreparation();
    const leg = async (ctx: AttemptLegContextV1) => {
      Object.defineProperty(ctx.cancelSignal!, "aborted", { value: true, configurable: true });
      return { ...succeededLeg(), phaseState: "cancelled" as const };
    };
    expect(await executePhaseAttempt(attemptRequest(staged, { leg })))
      .toMatchObject({ status: "committed", phaseState: "cancelled" });
    expect(await readRunState(staged)).toBe("running");
  });

  it("wires the executor cancel signal into the provider invocation", async () => {
    staged = await stagePreparation();
    let captured: AbortSignal | undefined;
    const invoke: ProviderInvokeFn = async (request) => {
      captured = (request as { hostSignal?: AbortSignal }).hostSignal;
      return { kind: "completed", admitted: { outcome: "succeeded", acceptedArtifacts: [], counts: { declared: 0, acceptedArtifacts: 0, requiredMissing: 0, receipts: 0 }, receipts: [], usage: { brokerRequestCount: 0, tokenCount: "unobserved", costMicros: "unobserved" }, untrusted: { untrusted: true, providerReportedCounts: null, warnings: null, output: null } } };
    };
    const controller = new AbortController();
    const runner = providerLegRunner({ request: providerRequest(), host: {} as never, preparationRunId: staged.binding.runId }, invoke);
    await runner({
      attemptId: "pat" as never, lease: { pid: 1, leaseNonce: "n", acquiredAt: "t" }, cancelSignal: controller.signal,
      sealed: { phaseInstanceId: "phi", executor: { kind: "provider-capability", providerPinDigest: PIN, capabilityId: "gather", capabilityContractDigest: PIN }, bounds: wideBounds(), authority: { inputExposureSetDigest: EXPOSURE } } as never,
    });
    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured!.aborted).toBe(false);
    controller.abort();
    expect(captured!.aborted).toBe(true);
  });
});

/** The current run state for a staged preparation. */
async function readRunState(staged: StagedPreparation): Promise<string> {
  const read = await readPreparationRun(staged.root, staged.binding);
  if (read.status !== "ok") throw new Error("run unavailable");
  return read.run.state;
}
