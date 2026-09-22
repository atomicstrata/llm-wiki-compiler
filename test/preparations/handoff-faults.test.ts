/**
 * @file test/preparations/handoff-faults.test.ts
 * @description Crash-resumption and no-duplication contract for the handoff
 * (design section 22.4). A crash after `handoff-started` but before bundle
 * creation, and a crash after bundle creation but before `handed-off`, both resume
 * to the EXACT same bundle from the durable reserved-identity authority — never a
 * duplicate. The recovery gate independently settles a fully-created handoff whose
 * `handed-off` transition never landed, and a resume whose recompiled bundle would
 * differ is refused as a conflict rather than overwriting.
 */

import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { handoffPreparation } from "../../src/preparations/handoff.js";
import { scanOperationInventory } from "../../src/operation-bundles/capacity.js";
import { acquireMutationLockBlocking } from "../../src/operation-bundles/lock-gate.js";
import { releaseLock } from "../../src/utils/lock.js";
import {
  stageReadyPreparation, handoffRequest, expectRunState, divergentGenesisAuthorities,
  readCreatedGenesisRun, CRASH_BEFORE_STAGE as crash, CRASH_AFTER_STAGE as crashAfterStage,
} from "./handoff-fixture.js";

const root = useTempRoot();

/** Assert the run reached a state and the bundle count is exact. */
async function expectState(dir: string, binding: Awaited<ReturnType<typeof stageReadyPreparation>>, state: string, bundles: number): Promise<void> {
  await expectRunState(dir, binding, state);
  expect((await scanOperationInventory(dir)).manifests.length).toBe(bundles);
}

describe("handoff crash resumption never duplicates or overwrites", () => {
  it.each([
    { boundary: "before bundle creation", fault: crash, bundles: 0 },
    { boundary: "after bundle creation", fault: crashAfterStage, bundles: 1 },
  ])("resumes a crash $boundary idempotently", async ({ fault, bundles }) => {
    const binding = await stageReadyPreparation(root.dir);
    await expect(handoffPreparation(root.dir, handoffRequest(binding, "ada", { faultsForTest: fault }))).rejects.toThrow("crash");
    await expectState(root.dir, binding, "handoff-started", bundles);
    const result = await handoffPreparation(root.dir, handoffRequest(binding));
    expect(result.outcome).toBe("resumed");
    await expectState(root.dir, binding, "handed-off", 1);
  });

  it("lets the recovery gate settle a fully-created handoff that never recorded handed-off", async () => {
    const binding = await stageReadyPreparation(root.dir);
    await expect(handoffPreparation(root.dir, handoffRequest(binding, "ada", { faultsForTest: crashAfterStage }))).rejects.toThrow("crash");
    await acquireMutationLockBlocking(root.dir, "ordinary");
    await releaseLock(root.dir);
    await expectState(root.dir, binding, "handed-off", 1);
  });

  it("refuses a resume whose recompiled bundle would differ from the reserved digest", async () => {
    const binding = await stageReadyPreparation(root.dir);
    await expect(handoffPreparation(root.dir, handoffRequest(binding, "ada", { faultsForTest: crash }))).rejects.toThrow("crash");
    await expect(handoffPreparation(root.dir, handoffRequest(binding, "grace"))).rejects.toMatchObject({ code: "digest-conflict" });
  });

  it("refuses a resume whose genesis run authority diverges though the manifest digest is invariant", async () => {
    const binding = await stageReadyPreparation(root.dir);
    await expect(handoffPreparation(root.dir, handoffRequest(binding, "ada", { faultsForTest: crash }))).rejects.toThrow("crash");
    await expectState(root.dir, binding, "handoff-started", 0);
    await expect(handoffPreparation(root.dir, handoffRequest(binding, "ada", { authorities: divergentGenesisAuthorities() })))
      .rejects.toMatchObject({ code: "digest-conflict" });
  });

  it("creates the genesis from the recorded authority even if the caller mutates it after handoff-started", async () => {
    const binding = await stageReadyPreparation(root.dir);
    const request = handoffRequest(binding);
    const authority = request.authorities.operationRun as { controlTransitionAllowance: number };
    const mutateAfterStarted = { afterHandoffStarted: async () => { authority.controlTransitionAllowance = 16; } };
    const result = await handoffPreparation(root.dir, { ...request, faultsForTest: mutateAfterStarted });
    expect((await readCreatedGenesisRun(root.dir, binding, result)).controlTransitionAllowance).toBe(8);
  });
});
