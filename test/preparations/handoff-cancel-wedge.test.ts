/**
 * @file test/preparations/handoff-cancel-wedge.test.ts
 * @description The `handoff-ready` cancellation wedge, and the custody that
 * removes it.
 *
 * THE WEDGE, exactly. `cancel` permitted a run at `handoff-ready`; nothing could
 * consume the advisory there (no attempt can start, the settlement leg selects
 * neither state, the terminal residue collector skips a run that can still move);
 * and `handoffPreparation` then refused on that same advisory on every call. So a
 * single cancel left the run with no way forward and no way to retract — while
 * the operator had been told their request was in flight.
 *
 * THE FIX IS CUSTODY, NOT A RETRACTION VERB. The coordinator carries the request
 * into the durable `cancelling` record, which hands the run to a settlement that
 * already exists. Every case here therefore ends by proving the SYSTEM IS USABLE
 * rather than merely moved: the run is out of the derived set nothing consumes,
 * the project still takes an ordinary mutation, and two acquisitions later the
 * run has reached its honest terminal with the advisory consumed. A fix that only
 * relocated the wedge would satisfy a state assertion and fail those.
 */

import { describe, expect, it } from "vitest";
import { acquireMutationLockBlocking } from "../../src/operation-bundles/lock-gate.js";
import { acquireLock, releaseLock } from "../../src/utils/lock.js";
import { preparationRunPredecessor } from "../../src/preparations/run-integrity.js";
import {
  readPreparationCancel, writePreparationCancelLockFree,
} from "../../src/preparations/cancellation.js";
import { handoffPreparation } from "../../src/preparations/handoff.js";
import {
  ADVISORY_UNCONSUMED_RUN_STATES, CANCEL_SETTLEABLE_RUN_STATES,
} from "../../src/preparations/attempts/cancel-settlement.js";
import { LEGAL_EDGES } from "../../src/preparations/run-validation.js";
import {
  appendPreparationTransitionLocked, readPreparationRun,
} from "../../src/preparations/run-store.js";
import { createPreparationService } from "../../src/preparations/service.js";
import type { PreparationRunBinding, PreparationRunV1 } from "../../src/preparations/run-types.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import {
  CRASH_BEFORE_STAGE, handoffRequest, stageDivergentReservedGenesis, stageReadyPreparation,
} from "./handoff-fixture.js";

const root = useTempRoot();

/** The local-operator service every case here publishes its cancellation through. */
function service(dir: string) {
  return createPreparationService({
    root: dir, surface: "cli",
    principals: { principalFor: () => ({ id: "operator", surface: "cli", grants: [] }) },
  });
}

/** Drive one REAL gated mutation acquisition — production's settlement trigger. */
async function gatedMutation(dir: string): Promise<void> {
  await acquireMutationLockBlocking(dir, "ordinary");
  await releaseLock(dir);
}

/** Leave one run durably at `handoff-started` through a real crash seam. */
async function crashAtHandoffStarted(binding: PreparationRunBinding): Promise<void> {
  await expect(handoffPreparation(root.dir, {
    ...handoffRequest(binding), faultsForTest: CRASH_BEFORE_STAGE,
  })).rejects.toThrow();
}

/** Append one control transition, for a legal edge no production writer takes. */
async function driveTo(binding: PreparationRunBinding, state: "handoff-ready"): Promise<void> {
  await acquireLock(root.dir, { quiet: true });
  try {
    const run = await readRun(root.dir, binding);
    await appendPreparationTransitionLocked(root.dir, binding, preparationRunPredecessor(run), {
      type: state, stateAfter: state, actor: { id: "operator", surface: "cli" },
      at: "2026-08-08T00:00:00.500Z", payload: { kind: "none" },
    });
  } finally {
    await releaseLock(root.dir);
  }
}

/** The run as it durably stands. */
async function readRun(dir: string, binding: PreparationRunBinding): Promise<PreparationRunV1> {
  const read = await readPreparationRun(dir, binding);
  if (read.status !== "ok") throw new Error(`run ${read.status}`);
  return read.run;
}

/**
 * The whole point of the fix, asserted as one thing: the advisory is no longer
 * orphaned, and the project still works.
 *
 * The advisory is deliberately NOT required to be gone yet — the existing
 * discipline drops it only once the operator's intent is durably held, which is
 * the terminal, not the carry. What must be true after the carry is that the run
 * is out of the set nothing consumes. A test that only checked "not
 * handoff-ready" would pass against a fix that moved the run somewhere equally
 * unconsumed, and one that demanded the advisory be gone would be asserting
 * against the discipline rather than for it.
 */
async function expectNoLongerOrphaned(dir: string, binding: PreparationRunBinding): Promise<void> {
  const run = await readRun(dir, binding);
  expect(ADVISORY_UNCONSUMED_RUN_STATES.has(run.state)).toBe(false);
  expect(CANCEL_SETTLEABLE_RUN_STATES.has(run.state) || LEGAL_EDGES[run.state].size === 0).toBe(true);
  await expect(gatedMutation(dir)).resolves.toBeUndefined();
}

describe("a cancellation over a handoff-ready run is taken into custody", () => {
  it("carries the request into cancelling on the next gated acquisition", async () => {
    const binding = await stageReadyPreparation(root.dir);
    expect(await service(root.dir).cancel({ runId: binding.runId }))
      .toMatchObject({ status: "requested", request: "created" });
    // Before the sweep the run is exactly where the wedge left it.
    expect((await readRun(root.dir, binding)).state).toBe("handoff-ready");
    await gatedMutation(root.dir);
    expect((await readRun(root.dir, binding)).state).toBe("cancelling");
    await expectNoLongerOrphaned(root.dir, binding);
  });

  it("settles the carried run rather than leaving it at cancelling", async () => {
    const binding = await stageReadyPreparation(root.dir);
    await service(root.dir).cancel({ runId: binding.runId });
    // Two acquisitions: the first carries, the second settles what it carried.
    await gatedMutation(root.dir);
    await gatedMutation(root.dir);
    const run = await readRun(root.dir, binding);
    // The fixture plan is structurally effect-free, so the honest terminal is the
    // CLEAN one — asserted exactly rather than as "a terminal or a park", because
    // the two mean different things to an operator and only one is provable here.
    expect(run.state).toBe("cancelled");
    expect(LEGAL_EDGES[run.state].size).toBe(0);
    // The consumed advisory is dropped only once that terminal is durable.
    expect((await readPreparationCancel(root.dir, binding.workspaceId, binding.runId)).status)
      .toBe("absent");
  });

  it("is idempotent: repeated acquisitions add no second cancelling record", async () => {
    const binding = await stageReadyPreparation(root.dir);
    await service(root.dir).cancel({ runId: binding.runId });
    for (let pass = 0; pass < 4; pass += 1) await gatedMutation(root.dir);
    const run = await readRun(root.dir, binding);
    expect(run.transitions.filter((each) => each.type === "cancelling")).toHaveLength(1);
  });

  it("moves NOTHING when no cancellation was ever published", async () => {
    // The anti-vacuity half: a carry that fired unconditionally would satisfy
    // every assertion above while cancelling runs nobody asked to cancel.
    const binding = await stageReadyPreparation(root.dir);
    await gatedMutation(root.dir);
    expect((await readRun(root.dir, binding)).state).toBe("handoff-ready");
  });
});

describe("a run whose handoff reserved identities is not carried anywhere", () => {
  /**
   * Park a run that reached `handoff-started` back to `recovery-required`.
   *
   * A crash before staging plus an out-of-band create under a DIVERGENT genesis
   * authority is what the recovery gate parks — and the parked run keeps its
   * start binding, which is the fact all three cancellation legs turn on.
   */
  async function parkAfterHandoffStarted(binding: PreparationRunBinding): Promise<void> {
    await crashAtHandoffStarted(binding);
    await stageDivergentReservedGenesis(root.dir, binding);
    await gatedMutation(root.dir);
    expect((await readRun(root.dir, binding)).state).toBe("recovery-required");
  }

  it("does NOT carry a handoff-ready run that still holds reserved identities", async () => {
    // `recovery-required -> handoff-ready` is a legal edge with no production
    // writer yet, so this state is driven here — and it is the only shape in
    // which the carry leg's sibling guard can be observed at all. Without the
    // guard the run is carried to `cancelling`, where the classifier blocks on
    // the very binding this test plants and no writer of
    // `cancelling -> recovery-required` is ever reached: a permanent wedge
    // installed by the code that exists to remove one.
    const binding = await stageReadyPreparation(root.dir);
    await parkAfterHandoffStarted(binding);
    await driveTo(binding, "handoff-ready");
    await writePreparationCancelLockFree(root.dir, {
      workspaceId: binding.workspaceId, runId: binding.runId, requester: "operator",
      at: "2026-08-08T00:00:01.000Z", nonce: "c".repeat(32),
    });
    await gatedMutation(root.dir);
    const run = await readRun(root.dir, binding);
    expect(run.state).toBe("handoff-ready");
    expect(run.transitions.filter((each) => each.type === "cancelling")).toHaveLength(0);
  });

  it("refuses to publish a request over a parked run the handoff still owns", async () => {
    // The MIRROR of the carry-leg omission, and the reason the guard is a fact
    // about the RECORD rather than about the state: `recovery-required` is a
    // perfectly honorable state, and this run is in it while carrying reserved
    // identities that make every cancellation move unprovable.
    const binding = await stageReadyPreparation(root.dir);
    await parkAfterHandoffStarted(binding);
    const result = await service(root.dir).cancel({ runId: binding.runId });
    expect(result).toMatchObject({ status: "refused" });
    expect(result.status === "refused" && result.reason).toMatch(/committed to its reserved bundle identities/);
  });

  it("collects an advisory left over such a run instead of leaving it pending", async () => {
    // Published while the run was still `handoff-ready` — legitimately, because
    // no binding existed yet — and orphaned by the park. The settlement leg
    // vetoes it and the terminal residue collector never sees it, so before this
    // fix the operator had a request pending that nothing would ever act on.
    const binding = await stageReadyPreparation(root.dir);
    await parkAfterHandoffStarted(binding);
    // WRITTEN LOCK-FREE, which is the only way this state is now reachable: the
    // publishing surface refuses both before and after the park, so the advisory
    // can only land in the window between the handoff's pre-commit check and its
    // durable `handoff-started` append. The test reproduces the OUTCOME of that
    // race rather than pretending a command sequence produced it.
    await writePreparationCancelLockFree(root.dir, {
      workspaceId: binding.workspaceId, runId: binding.runId, requester: "operator",
      at: "2026-08-08T00:00:00.000Z", nonce: "b".repeat(32),
    });
    await gatedMutation(root.dir);
    expect((await readPreparationCancel(root.dir, binding.workspaceId, binding.runId)).status)
      .toBe("absent");
    // AND THE RUN IS UNTOUCHED: collecting the residue is not settling it. The
    // handoff still owns the run, and no cancellation state was claimed over it.
    const run = await readRun(root.dir, binding);
    expect(run.state).toBe("recovery-required");
    expect(run.transitions.filter((each) => each.type === "cancelling")).toHaveLength(0);
  });
});

describe("a committed handoff is not cancellable, and is not blocked by a cancel", () => {
  it("refuses to publish a request over a run that has already committed", async () => {
    const binding = await stageReadyPreparation(root.dir);
    await crashAtHandoffStarted(binding);
    expect((await readRun(root.dir, binding)).state).toBe("handoff-started");
    const result = await service(root.dir).cancel({ runId: binding.runId });
    expect(result).toMatchObject({ status: "refused" });
    expect(result.status === "refused" && result.reason).toMatch(/committed to its reserved bundle identities/);
    // NOT A DEAD END, and the exit the refusal NAMES is the one that is taken:
    // completing the handoff. A pre-stage crash leaves no Milestone A pair, so
    // the coordinator deliberately leaves this run to its own command — which is
    // why the message says "complete or park" rather than promising a sweep.
    expect((await handoffPreparation(root.dir, handoffRequest(binding))).outcome).toBe("resumed");
    expect((await readRun(root.dir, binding)).state).toBe("handed-off");
    // And from there the refusal is the ordinary terminal one.
    expect(await service(root.dir).cancel({ runId: binding.runId }))
      .toMatchObject({ status: "refused", reason: expect.stringContaining("already terminal") });
  });

  it("RESUMES a committed handoff even with an advisory already on disk", async () => {
    // The race the refusal above cannot close: the advisory is published in the
    // window between the substrate's pre-commit check and its durable
    // `handoff-started` append. Refusing the resume on it refused forever —
    // `handoff-started` admits no edge to `cancelling` and no verb retracts a
    // request — so the commitment itself became the wedge.
    const binding = await stageReadyPreparation(root.dir);
    await crashAtHandoffStarted(binding);
    await writePreparationCancelLockFree(root.dir, {
      workspaceId: binding.workspaceId, runId: binding.runId, requester: "operator",
      at: "2026-08-07T00:00:00.000Z", nonce: "a".repeat(32),
    });
    const resumed = await handoffPreparation(root.dir, handoffRequest(binding));
    expect(resumed.outcome).toBe("resumed");
    expect((await readRun(root.dir, binding)).state).toBe("handed-off");
    // And the request is then collected as terminal residue rather than left.
    await gatedMutation(root.dir);
    expect((await readPreparationCancel(root.dir, binding.workspaceId, binding.runId)).status)
      .toBe("absent");
  });
});
