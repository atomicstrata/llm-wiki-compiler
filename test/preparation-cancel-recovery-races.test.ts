/**
 * @file test/preparation-cancel-recovery-races.test.ts
 * @description The Task 11 race cases these two operations specifically create:
 * cancel against attempt start, cancel against settlement, and recovery against
 * a pending cancel — each driven through the SERVICE rather than through the
 * substrate primitive it wraps.
 *
 * WHY THROUGH THE SERVICE, when the substrate races are already covered. The
 * advisory record is canonical-byte-bound and identity-bound to its path, and
 * the READER rejects anything that is not exactly canonical. So a service that
 * assembles a subtly different record publishes a file the executor silently
 * ignores: the operator's cancel is accepted, durable, and never honored, with
 * every substrate suite still green. These cases exist to make the service's OWN
 * bytes reach a real consumer.
 *
 * THE SETTLEMENT IS NEVER CALLED DIRECTLY. Every re-drive here is triggered by a
 * real gated mutation acquisition — the same trigger production has — because a
 * suite that calls the coordinator itself proves the coordinator works and says
 * nothing about whether anything ever calls it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { acquireMutationLockBlocking } from "../src/operation-bundles/lock-gate.js";
import { readPreparationCancel } from "../src/preparations/cancellation.js";
import { recordDurableCancellingLocked } from "../src/preparations/attempts/cancel-settlement.js";
import { executePhaseAttempt } from "../src/preparations/attempts/execute.js";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import { attemptRequest, stagePreparation, type StagedPreparation } from "./preparations/attempt-fixture.js";
import {
  readRun as readStagedRun, settlementInput, underLock,
} from "./preparations/cancel-settlement-fixture.js";
import {
  CANCEL_RECOVERY_GRANTS, driveRunning, readRun, serviceOn, stagedProject,
  type RunningRunFixture,
} from "./preparation-recovery-fixture.js";

/** Publish a cancellation for a staged attempt fixture, through the service. */
function cancelStaged(staged: StagedPreparation) {
  return serviceOn(staged.root, "sdk", CANCEL_RECOVERY_GRANTS).cancel({
    runId: staged.binding.runId,
  });
}

/** Whether a VALID advisory request is still on disk for one run. */
async function advisoryPresent(root: string, workspaceId: string, runId: string): Promise<boolean> {
  const read = await readPreparationCancel(root, workspaceId, runId as never);
  return read.status === "present";
}

/** Drive one REAL gated mutation acquisition — production's settlement trigger. */
async function gatedMutation(root: string): Promise<void> {
  await acquireMutationLockBlocking(root, "ordinary");
  await releaseLock(root);
}

/** A stranded run with a pending cancellation, and the service that made both. */
async function strandedWithPendingCancel(prefix: string) {
  const target = await stagedProject(prefix);
  await driveRunning(target, "stranded");
  const service = serviceOn(target.root, "sdk", CANCEL_RECOVERY_GRANTS);
  const requested = await service.cancel({ runId: target.binding.runId });
  expect(requested).toMatchObject({ request: "created" });
  return { target, service };
}

/** Whether this fixture's run still carries a valid pending request. */
function pendingCancel(target: RunningRunFixture): Promise<boolean> {
  return advisoryPresent(target.root, target.binding.workspaceId, target.binding.runId);
}

describe("cancel races attempt start", () => {
  let staged: StagedPreparation | undefined;
  afterEach(async () => { await staged?.cleanup(); staged = undefined; });

  it("stops a leg that has not started, through the service's OWN advisory bytes", async () => {
    staged = await stagePreparation();
    expect(await cancelStaged(staged)).toMatchObject({ status: "requested", request: "created" });

    const outcome = await executePhaseAttempt(attemptRequest(staged, {
      leg: async () => { throw new Error("leg must not run after a cancel request"); },
    }));

    expect(outcome).toMatchObject({ status: "committed", phaseState: "cancelled" });
    // Effect-free by plan, so the acknowledgement advances to the honest terminal
    // and the consumed advisory is dropped.
    expect((await readStagedRun(staged)).state).toBe("cancelled");
    expect(await advisoryPresent(staged.root, staged.binding.workspaceId, staged.binding.runId)).toBe(false);
  });

  it("refuses a cancel that arrives after the run already settled, leaving no litter", async () => {
    // The other side of the same race. A terminal run is in no settleable state,
    // so an advisory published over it would never be consumed by anything.
    staged = await stagePreparation();
    await cancelStaged(staged);
    await executePhaseAttempt(attemptRequest(staged, { leg: async () => { throw new Error("no leg"); } }));
    expect((await readStagedRun(staged)).state).toBe("cancelled");

    const late = await cancelStaged(staged);

    expect(late.status).toBe("refused");
    expect(await advisoryPresent(staged.root, staged.binding.workspaceId, staged.binding.runId)).toBe(false);
  });
});

describe("cancel races settlement", () => {
  let staged: StagedPreparation | undefined;
  afterEach(async () => { await staged?.cleanup(); staged = undefined; });

  it("is consumed by the coordinator's re-drive rather than surviving it", async () => {
    // A run left `cancelling` by a crash between the two cancel appends has no
    // writer of its own; the gate's recovery leg is what advances it. The
    // service's request must be the thing that leg observes, and must be gone
    // once its intent is durably held.
    staged = await stagePreparation();
    await executePhaseAttempt(attemptRequest(staged));
    expect(await cancelStaged(staged)).toMatchObject({ request: "created" });
    // The crash state, written by the same production writer the executor uses.
    await underLock(staged.root, () => recordDurableCancellingLocked(settlementInput(staged as StagedPreparation)));
    expect((await readStagedRun(staged)).state).toBe("cancelling");

    await gatedMutation(staged.root);

    const settled = await readStagedRun(staged);
    expect(settled.state).toBe("cancelled");
    expect(settled.transitions.at(-1)).toMatchObject({ actor: { id: "recovery", surface: "recovery" } });
    expect(await advisoryPresent(staged.root, staged.binding.workspaceId, staged.binding.runId)).toBe(false);
  });
});

describe("cancel races fail", () => {
  let fixture: RunningRunFixture | undefined;
  afterEach(async () => { await fixture?.cleanup(); fixture = undefined; });

  it("leaves no uncollectable request when the run goes terminal underneath it", async () => {
    // THE WINDOW IS INHERENT, not an omission. Cancel's terminal check is a
    // pre-write observation taken under NO LOCK — that is the property the
    // operation exists for — so a `fail` landing between that check and the
    // create-only write is always possible. Both verbs here are shipped ones and
    // neither does anything wrong.
    //
    // What must not happen is the operator being told "cancellation requested"
    // about a file nothing will ever collect: a terminal run admits no
    // transition, so no settlement can consume it, and `list` reports no problem.
    fixture = await stagedProject("racecancelfail");
    const target = fixture;
    const service = serviceOn(target.root, "sdk", ["preparation.cancel", "preparation.run"]);
    expect(await service.cancel({ runId: target.binding.runId })).toMatchObject({ request: "created" });
    expect(await service.fail({ runId: target.binding.runId })).toMatchObject({ status: "failed" });
    // PIN THE PRECONDITION: the residue really is there before the collection.
    expect(await pendingCancel(target)).toBe(true);

    await gatedMutation(target.root);

    expect(await pendingCancel(target)).toBe(false);
    // And the run itself is untouched by the collection — the advisory was
    // residue, not intent, so nothing was honoured on the way out.
    expect((await readRun(target)).state).toBe("failed");
  });
});

describe("recovery races cancel", () => {
  let fixture: RunningRunFixture | undefined;
  afterEach(async () => { await fixture?.cleanup(); fixture = undefined; });

  it("parks a stranded run WITHOUT dropping the pending cancellation", async () => {
    // THE UNHONORED REQUEST MUST SURVIVE. The advisory has no temporal bound
    // precisely so an operator cancel that a dead process never acted on is
    // still visible to the next settlement; a park that consumed it would
    // silently discard the operator's intent and leave the run parked forever
    // with nothing to say why.
    const { target, service } = await strandedWithPendingCancel("racereccancel");
    fixture = target;

    expect(await service.recovery({ runId: target.binding.runId })).toMatchObject({ status: "parked" });

    expect((await readRun(target)).state).toBe("recovery-required");
    expect(await pendingCancel(target)).toBe(true);
  });

  it("does not let the preserved request convert an INTEGRITY park into a cancel terminal", async () => {
    // THE PARK-PROVENANCE RULE, held through a path that did not exist when it
    // was written. `recovery-required` is where every fail-closed park lands, so
    // an advisory sitting beside one is not evidence the park was ABOUT
    // cancellation — anyone may write one at any time. The recovery park records
    // an integrity obligation, and the settlement must decline to advance it even
    // though a cancellation is genuinely observed.
    //
    // This is a real limit and it is stated rather than papered over: the run
    // rests at `recovery-required` with the operator's request still visible, and
    // honouring it needs the abandonment path this slice does not carry.
    const { target, service } = await strandedWithPendingCancel("raceprovenance");
    fixture = target;
    await service.recovery({ runId: target.binding.runId });

    await gatedMutation(target.root);

    expect((await readRun(target)).state).toBe("recovery-required");
    // The request is neither honoured nor discarded — it stays visible.
    expect(await pendingCancel(target)).toBe(true);
  });

  it("lands the cancel and refuses the recovery under the SAME held lock", async () => {
    // The asymmetry §5 row 8 exists for, observed under one contention rather
    // than argued from two separate setups: the locked verb refuses, the
    // lock-free one lands, and the operator is not left without a move.
    fixture = await stagedProject("racereclock");
    await driveRunning(fixture, "stranded");
    const service = serviceOn(fixture.root, "sdk", CANCEL_RECOVERY_GRANTS);
    await acquireLock(fixture.root, { quiet: true });
    try {
      expect(await service.recovery({ runId: fixture.binding.runId }))
        .toMatchObject({ status: "refused", reason: "project lock is busy" });
      expect(await service.cancel({ runId: fixture.binding.runId }))
        .toMatchObject({ status: "requested", request: "created" });
    } finally {
      await releaseLock(fixture.root);
    }
    expect(await advisoryPresent(fixture.root, fixture.binding.workspaceId, fixture.binding.runId)).toBe(true);
    // The run is untouched by the refusal, so recovery still works once the lock
    // clears — the refusal delayed the operator, it did not strand the run.
    expect((await readRun(fixture)).state).toBe("running");
    expect(await service.recovery({ runId: fixture.binding.runId })).toMatchObject({ status: "parked" });
  });
});
