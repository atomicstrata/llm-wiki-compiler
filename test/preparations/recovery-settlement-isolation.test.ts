/**
 * @file test/preparations/recovery-settlement-isolation.test.ts
 * @description What the under-lock cancellation re-drive must NOT do to its
 * neighbours. It runs inside an UNRELATED mutation's lock acquisition, so its
 * blast radius is the whole project: a run it cannot settle must not become that
 * mutation's refusal, and a run whose cancellation it cannot honestly reason
 * about must be left alone rather than force-settled.
 *
 * The append fault here is REAL — a run directory the process genuinely cannot
 * write to, so the durable append fails the way a full disk or a revoked
 * permission fails. Nothing is mocked and no record is planted.
 */

import { chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { acquireMutationLock, acquireMutationLockBlocking } from "../../src/operation-bundles/lock-gate.js";
import { releaseLock } from "../../src/utils/lock.js";
import { writePreparationCancelLockFree } from "../../src/preparations/cancellation.js";
import { scanPreparationInventory } from "../../src/preparations/capacity.js";
import { preparationPaths } from "../../src/preparations/paths.js";
import { executePhaseAttempt } from "../../src/preparations/attempts/execute.js";
import {
  recordDurableCancellingLocked, settleCancelledRunLocked,
} from "../../src/preparations/attempts/cancel-settlement.js";
import { handoffPreparation } from "../../src/preparations/handoff.js";
import type { PreparationRunBinding } from "../../src/preparations/run-types.js";
import { attemptRequest, stagePreparationIn, type StagedPreparation } from "./attempt-fixture.js";
import { fixturePlan } from "./store-fixture.js";
import { OPERATOR, readRun, settlementInput, underLock } from "./cancel-settlement-fixture.js";
import {
  CRASH_BEFORE_STAGE, expectRunState, handoffRequest, stageDivergentReservedGenesis, stageReadyPreparation,
} from "./handoff-fixture.js";

/** Two workspaces, so one run's directory can be made unwritable without the other's. */
const FAULT_WORKSPACE = "zfaulted";
const HEALTHY_WORKSPACE = "ahealthy";
const REQUESTED_AT = "2026-07-22T00:00:00.000Z";
const NONCE = "0".repeat(32);

/** Stage one preparation into the given workspace of an existing root. */
function stageInWorkspace(root: string, workspaceId: string): Promise<StagedPreparation> {
  return stagePreparationIn(root, fixturePlan((object) => { object.workspaceId = workspaceId; }));
}

/**
 * Leave one staged run at the `cancelling` half of the two-append window.
 *
 * Kept separate from the attempt that precedes it because `executePhaseAttempt`
 * takes a GATED lock, which runs the very loop under test: driving a second run
 * through an attempt after a first one is already `cancelling` would settle that
 * first run before the fault could be injected. Every attempt therefore runs
 * first, and these raw-lock appends follow.
 */
async function markCancelling(staged: StagedPreparation): Promise<void> {
  const { workspaceId, runId } = staged.binding;
  await writePreparationCancelLockFree(staged.root, { workspaceId, runId, requester: "op", at: REQUESTED_AT, nonce: NONCE });
  await underLock(staged.root, () => recordDurableCancellingLocked(settlementInput(staged)));
}

/** Drive one staged run through a real attempt, then to `cancelling`. */
async function leaveCancelling(staged: StagedPreparation): Promise<void> {
  await executePhaseAttempt(attemptRequest(staged));
  await markCancelling(staged);
}

describe("cancellation re-drive isolation", () => {
  let root: string | undefined;
  let unwritable: string | undefined;
  afterEach(async () => {
    if (unwritable !== undefined) await chmod(unwritable, 0o700);
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined; unwritable = undefined;
  });

  it("settles a healthy run in the same pass as one whose durable append fails", async () => {
    root = await mkdtemp(path.join(tmpdir(), "prep-settle-fault-"));
    const staged = new Map([
      [FAULT_WORKSPACE, await stageInWorkspace(root, FAULT_WORKSPACE)],
      [HEALTHY_WORKSPACE, await stageInWorkspace(root, HEALTHY_WORKSPACE)],
    ]);
    for (const run of staged.values()) await executePhaseAttempt(attemptRequest(run));
    for (const run of staged.values()) await markCancelling(run);
    // Break whichever run the loop will visit FIRST. The claim under test is that
    // the pass reaches the run BEHIND a failure, which only holds if the failure
    // comes first — and the scan's order is not part of any contract, so the test
    // DERIVES it rather than hand-writing an order that could silently flip and
    // leave this passing for the wrong reason.
    const [first, second] = (await scanPreparationInventory(root)).manifests.map((manifest) => manifest.workspaceId);
    unwritable = preparationPaths(root, first!).runsRoot;
    await chmod(unwritable, 0o500);
    await acquireMutationLockBlocking(root, "ordinary");
    await releaseLock(root);
    expect((await readRun(staged.get(second!)!)).state).toBe("cancelled");
    expect((await readRun(staged.get(first!)!)).state).toBe("cancelling");
  });

  it("does not refuse the acquisition that a failing settlement runs inside", async () => {
    root = await mkdtemp(path.join(tmpdir(), "prep-settle-fault-"));
    const faulted = await stageInWorkspace(root, FAULT_WORKSPACE);
    await leaveCancelling(faulted);
    unwritable = preparationPaths(root, FAULT_WORKSPACE).runsRoot;
    await chmod(unwritable, 0o500);
    expect(await acquireMutationLock(root, "ordinary")).toBe(true);
    await releaseLock(root);
    expect((await readRun(faulted)).state).toBe("cancelling");
  });

  it("re-drives the skipped run once its directory is writable again", async () => {
    root = await mkdtemp(path.join(tmpdir(), "prep-settle-fault-"));
    const faulted = await stageInWorkspace(root, FAULT_WORKSPACE);
    await leaveCancelling(faulted);
    const runsRoot = preparationPaths(root, FAULT_WORKSPACE).runsRoot;
    await chmod(runsRoot, 0o500);
    await acquireMutationLockBlocking(root, "ordinary");
    await releaseLock(root);
    await chmod(runsRoot, 0o700);
    await acquireMutationLockBlocking(root, "ordinary");
    await releaseLock(root);
    expect((await readRun(faulted)).state).toBe("cancelled");
  });
});

/** Crash one handoff after it reserved its identity, leaving the run parked. */
async function parkedHandoff(root: string): Promise<PreparationRunBinding> {
  await mkdir(path.join(root, "wiki"), { recursive: true });
  const binding = await stageReadyPreparation(root);
  await expect(handoffPreparation(root, handoffRequest(binding, "ada", { faultsForTest: CRASH_BEFORE_STAGE })))
    .rejects.toThrow("crash");
  await stageDivergentReservedGenesis(root, binding);
  expect(await acquireMutationLock(root, "ordinary")).toBe(true);
  await releaseLock(root);
  await expectRunState(root, binding, "recovery-required");
  return binding;
}

describe("cancellation re-drive scope", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  // A run parked out of `handoff-started` may already have created a Milestone A
  // bundle, which lives outside this run's effect ledger. The plan's phase
  // declarations prove nothing about it, so a clean `cancelled` here would be a
  // false claim of effect-freeness over durable state another authority owns.
  it("never settles a handoff-parked run, whose effects live outside the plan", async () => {
    root = await mkdtemp(path.join(tmpdir(), "prep-settle-scope-"));
    const binding = await parkedHandoff(root);
    const { workspaceId, runId } = binding;
    await writePreparationCancelLockFree(root, { workspaceId, runId, requester: "op", at: REQUESTED_AT, nonce: NONCE });
    expect(await acquireMutationLock(root, "ordinary")).toBe(true);
    await releaseLock(root);
    await expectRunState(root, binding, "recovery-required");
  });

  // The coordinator refuses this run before the settlement ever sees it, so the
  // case above cannot witness the PRIMITIVE's own guard — it would pass with the
  // classifier's check deleted. A caller-independent witness, because the
  // settlement is exported and the next caller inherits the guard rather than
  // remembering to repeat it.
  it("refuses a handoff-parked run when the settlement is called directly", async () => {
    root = await mkdtemp(path.join(tmpdir(), "prep-settle-scope-"));
    const binding = await parkedHandoff(root);
    expect(await settleCancelledRunLocked({ root, binding, principal: OPERATOR, at: REQUESTED_AT }))
      .toEqual({ status: "blocked", reason: "handoff-effects-outside-plan" });
  });
});
