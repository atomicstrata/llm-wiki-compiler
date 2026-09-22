/**
 * @file test/preparations/recovery-cancel-settlement.test.ts
 * @description The under-lock coordinator's cancellation re-drive (design section
 * 24.2). A cancel-interrupted run has no writer of its own once the attempt that
 * observed the cancel is gone, so the recovery leg the mutation gate already runs
 * must advance it. Every pending state here is produced by REAL production
 * writers — a real `.cancel` request, a real `executePhaseAttempt`, the real
 * durable `cancelling` append — and the settlement is triggered ONLY by a real
 * gated mutation acquisition, never by calling the settlement directly.
 */

import { afterEach, describe, expect, it } from "vitest";
import { acquireMutationLockBlocking } from "../../src/operation-bundles/lock-gate.js";
import { releaseLock } from "../../src/utils/lock.js";
import { abandonPreparationRunLocked } from "../../src/preparations/abandonment.js";
import { readPreparationCancel } from "../../src/preparations/cancellation.js";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { executePhaseAttempt } from "../../src/preparations/attempts/execute.js";
import { recordDurableCancellingLocked, settleCancelledRunLocked } from "../../src/preparations/attempts/cancel-settlement.js";
import {
  attemptRequest, driftingResolver, phaseInstanceIdFor, providerAuthority, stagePreparation,
  stagePreparationIn, succeededLeg, type StagedPreparation,
} from "./attempt-fixture.js";
import { externalEffectPlan, fixturePlan } from "./store-fixture.js";
import {
  OPERATOR, attemptSiblingPhase, readRun, requestCancel, settlementInput, underLock,
} from "./cancel-settlement-fixture.js";

/** A provider pin the seal never bound: re-resolving it at commit is real drift. */
const DRIFTED_PIN = parseSha256Digest(`sha256:${"b".repeat(64)}`);

const DECLARED_EFFECT = `sha256:${"a".repeat(64)}`;

/** A leg that cancels MID-FLIGHT: the request lands after the launch boundary. */
function midFlightCancelLeg(staged: () => StagedPreparation) {
  return async () => {
    await requestCancel(staged());
    return { ...succeededLeg(), phaseState: "cancelled" as const };
  };
}

/** Drive one REAL gated mutation acquisition — production's settlement trigger. */
async function gatedMutation(root: string): Promise<void> {
  await acquireMutationLockBlocking(root, "ordinary");
  await releaseLock(root);
}

/** Leave one run exactly where a crash between the two cancel appends leaves it. */
async function crashBetweenCancelAppends(staged: StagedPreparation): Promise<void> {
  await executePhaseAttempt(attemptRequest(staged));
  await requestCancel(staged);
  await underLock(staged.root, () => recordDurableCancellingLocked(settlementInput(staged)));
}

/** Park one run at `recovery-required` through real authority drift, no cancel. */
async function parkOnAuthorityDrift(staged: StagedPreparation): Promise<void> {
  const authorityResolver = driftingResolver(providerAuthority(), providerAuthority({ providerPinDigest: DRIFTED_PIN }));
  const outcome = await executePhaseAttempt(attemptRequest(staged, { authorityResolver }));
  expect(outcome).toMatchObject({ status: "parked", reason: "authority-drift" });
  expect((await readRun(staged)).state).toBe("recovery-required");
}

/** Assert the run reached the `cancelled` terminal, recorded by the recovery actor. */
async function expectRecoverySettledCancelled(staged: StagedPreparation): Promise<void> {
  const settled = await readRun(staged);
  expect(settled.state).toBe("cancelled");
  expect(settled.transitions.at(-1)).toMatchObject({ type: "cancelled", actor: { id: "recovery", surface: "recovery" } });
}

describe("under-lock cancellation settlement re-drive", () => {
  let staged: StagedPreparation | undefined;
  afterEach(async () => { await staged?.cleanup(); staged = undefined; });

  it("settles a crash-interrupted cancel on the next gated mutation acquisition", async () => {
    staged = await stagePreparation();
    await crashBetweenCancelAppends(staged);
    expect((await readRun(staged)).state).toBe("cancelling");
    await gatedMutation(staged.root);
    await expectRecoverySettledCancelled(staged);
  });

  it("drops the consumed advisory only once the terminal is durably recorded", async () => {
    staged = await stagePreparation();
    await crashBetweenCancelAppends(staged);
    expect((await readPreparationCancel(staged.root, staged.binding.workspaceId, staged.binding.runId)).status).toBe("present");
    await gatedMutation(staged.root);
    expect(await readPreparationCancel(staged.root, staged.binding.workspaceId, staged.binding.runId)).toEqual({ status: "absent" });
  });

  it("re-drives the settlement idempotently across repeated acquisitions", async () => {
    staged = await stagePreparation();
    await crashBetweenCancelAppends(staged);
    await gatedMutation(staged.root);
    const settled = await readRun(staged);
    await gatedMutation(staged.root);
    expect(await readRun(staged)).toEqual(settled);
  });

  it("leaves a blocked settlement untouched and still completes the acquisition", async () => {
    staged = await stagePreparation(externalEffectPlan(DECLARED_EFFECT));
    await executePhaseAttempt(attemptRequest(staged, { leg: midFlightCancelLeg(() => staged!) }));
    const parked = await readRun(staged);
    expect(parked.state).toBe("recovery-required");
    await expect(gatedMutation(staged.root)).resolves.toBeUndefined();
    expect(await readRun(staged)).toEqual(parked);
    expect((await readPreparationCancel(staged.root, staged.binding.workspaceId, staged.binding.runId)).status).toBe("present");
  });

  it("never moves a recovery-required run with no observed cancel to a cancel terminal", async () => {
    staged = await stagePreparation();
    await parkOnAuthorityDrift(staged);
    const parked = await readRun(staged);
    await gatedMutation(staged.root);
    expect(await readRun(staged)).toEqual(parked);
  });

  // `recovery-required` is where EVERY fail-closed park lands — authority drift,
  // a bounds violation, a failed publication, an unprovable cancellation. Anyone
  // may drop a `.cancel` file beside such a run, so advisory presence cannot be
  // the evidence that authorizes advancing it: treating it that way carried an
  // unrelated integrity obligation to a terminal and erased it. Only the park's
  // own recorded code says why the run is parked.
  it("refuses to settle a park an operator cancel did not cause, advisory or not", async () => {
    staged = await stagePreparation();
    await parkOnAuthorityDrift(staged);
    const parked = await readRun(staged);
    await requestCancel(staged);
    await gatedMutation(staged.root);
    expect(await readRun(staged)).toEqual(parked);
    expect(await settleCancelledRunLocked(settlementInput(staged)))
      .toEqual({ status: "blocked", reason: "park-not-a-cancellation" });
  });

  it("keeps the unhonored advisory when the park was not a cancellation", async () => {
    staged = await stagePreparation();
    await parkOnAuthorityDrift(staged);
    await requestCancel(staged);
    await gatedMutation(staged.root);
    expect((await readPreparationCancel(staged.root, staged.binding.workspaceId, staged.binding.runId)).status).toBe("present");
  });

  // `cancelling` is a REACHABLE resting state, not a momentary one: an
  // effect-capable plan whose settlement cannot prove a clean terminal stays
  // there. Nothing asserted what that state actually refuses — both the durable
  // record and the advisory exist to make cancellation sticky, and stickiness is
  // only real if a sibling phase cannot start behind it.
  // `cancelling` has no exits of its own: the two terminals need proof this run
  // cannot supply, and abandonment refuses anything but `recovery-required`. A
  // settlement that simply refused left an honestly-cancelled run wedged there
  // for good, so the sweep moves it to the park designated for the unprovable
  // case — recoverable, and still unstartable.
  it("moves an unsettleable cancelling run to a park it can be abandoned from", async () => {
    staged = await stagePreparation(externalEffectPlan(DECLARED_EFFECT));
    await crashBetweenCancelAppends(staged);
    expect((await readRun(staged)).state).toBe("cancelling");
    await gatedMutation(staged.root);
    const parked = await readRun(staged);
    expect(parked.state).toBe("recovery-required");
    expect(parked.transitions.at(-1)).toMatchObject({
      type: "recovery-required", payload: { code: "preparation-cancellation-effect-unproven" },
    });
    const abandoned = await abandonPreparationRunLocked(staged.root, {
      binding: staged.binding, actor: OPERATOR, at: "2026-07-22T01:00:00.000Z", confirmResidualState: true,
    });
    expect(abandoned.state).toBe("abandoned");
  });

  // The escape must not weaken stickiness: still unstartable while it rests there.
  it("still refuses a sibling attempt once the unsettleable run has parked", async () => {
    staged = await stagePreparation(externalEffectPlan(DECLARED_EFFECT));
    await crashBetweenCancelAppends(staged);
    await gatedMutation(staged.root);
    const sibling = await attemptSiblingPhase(staged);
    expect(sibling).toMatchObject({ status: "parked", reason: "run-not-startable-recovery-required" });
  });

  // The advisory is dropped only once its intent is durably held, so the caller
  // has to be able to tell a real append from a no-op. Both legs are reported.
  it("reports whether the durable cancelling record was actually appended", async () => {
    staged = await stagePreparation();
    await executePhaseAttempt(attemptRequest(staged));
    await requestCancel(staged);
    expect(await underLock(staged.root, () => recordDurableCancellingLocked(settlementInput(staged!)))).toBe(true);
    expect(await underLock(staged.root, () => recordDurableCancellingLocked(settlementInput(staged!)))).toBe(false);
  });

  it("settles a settleable run in the same pass as an unsettleable sibling", async () => {
    staged = await stagePreparation(externalEffectPlan(DECLARED_EFFECT));
    await executePhaseAttempt(attemptRequest(staged, { leg: midFlightCancelLeg(() => staged!) }));
    const sibling = await stagePreparationIn(staged.root, fixturePlan());
    await crashBetweenCancelAppends(sibling);
    // Deliberately order-independent: the scan's visit order is not part of any
    // contract and is not stable across runs, so pinning it here made this test
    // pass or fail for reasons unrelated to the code. The ORDERED claim — that a
    // pass reaches the run behind one it could not advance — is proven
    // deterministically in `recovery-settlement-isolation.test.ts`, which derives
    // the order and breaks whichever run is visited first. What this adds is that
    // a blocked run and a settleable one reach their correct, different states in
    // the same pass.
    await gatedMutation(staged.root);
    expect((await readRun(sibling)).state).toBe("cancelled");
    expect((await readRun(staged)).state).toBe("recovery-required");
  });
});
