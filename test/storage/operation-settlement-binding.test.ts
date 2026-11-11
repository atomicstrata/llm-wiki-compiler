/**
 * @file test/storage/operation-settlement-binding.test.ts
 * @description Settling a parked operation run as ONE body each, over steps
 * that take no project root: compensation (`compensateOperationBundleWith`),
 * crash recovery and operator resume (`recoverOperationRunWith`,
 * `resumeOperationRecoveryWith`) over `OperationRunStores`, and recovery
 * planning and settlement (`planRecoveryBundleWith`,
 * `settleOriginalFromRecoveryWith`) over `RecoveryPlanSteps`.
 *
 * HOW IT IS BUILT. Real runs are parked on disk with the existing fixtures and
 * copied into the shared memory run stores (`operation-run-memory.ts`). With the
 * same fixed clock, authority and fresh adapter doubles, the body over memory
 * must leave the SAME signed run and return the same result as the root form
 * leaves on disk. Memory cases pin each gate's reads and the transitions it
 * must not write. The root forms are shown reaching the staging transaction and
 * the recovered writer with exact arguments.
 *
 * NOT SHOWN HERE: the compensators and observers (the runtime's adapters), the
 * staging transaction and the recovered writer's own verification; the
 * compensation, recovery and recovery-bundle suites show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import { compensateOperationBundleLocked, compensateOperationBundleWith } from "../../src/operation-bundles/compensation.js";
import {
  planRecoveryBundleLocked, planRecoveryBundleWith, settleOriginalFromRecoveryLocked, settleOriginalFromRecoveryWith,
  type RecoveryPlanRequest, type RecoveryPlanSteps,
} from "../../src/operation-bundles/recovery-plan.js";
import { recoverOperationRunWith, resumeOperationRecoveryLocked, resumeOperationRecoveryWith } from "../../src/operation-bundles/recovery.js";
import * as runStore from "../../src/operation-bundles/run-store.js";
import * as stage from "../../src/operation-bundles/stage.js";
import {
  approveRequest, compensatingSourceAdapter, fixtureSnapshot, parkedSourceBundle, parkViaMidApplyCancel, readStagedRun,
  sourceRecoveryPlanner, stageCompensatableBundle, stageSourceBundle, unboundSourceAdapter, type StagedBundle,
} from "../operation-bundles/executor-fixtures.js";
import { tempRootTracker } from "../temp-roots.js";
import { copiedProject, memoryRunStores, runtimeOf, type CopiedProject } from "./operation-run-memory.js";

const tracker = tempRootTracker();
afterEach(async () => { vi.restoreAllMocks(); await tracker.cleanup(); });

/** A compensatable bundle parked mid-apply with its first mutation applied. */
const parkedMidApply = (root: string): Promise<StagedBundle> =>
  stageCompensatableBundle(root).then(async (staged) => { await parkViaMidApplyCancel(root, staged, compensatingSourceAdapter()); return staged; });
/** An authority whose snapshot drifted from the one the run recorded. */
const drifted = { async computeSnapshot(request: never) { return { status: "ok" as const, ...fixtureSnapshot(request, "drifted") }; } };

/** Run `body` over memory, then `root` over the same project, each with a fresh runtime: results, final runs, memory log. */
async function bothWays(seed: CopiedProject, body: typeof compensateOperationBundleWith, root: typeof compensateOperationBundleLocked, source = () => compensatingSourceAdapter(true)) {
  const log: string[] = [];
  const stores = memoryRunStores(seed, log);
  const memory = await body(stores, approveRequest(seed.staged, runtimeOf([], { source: source() })), "cancellation");
  const disk = await root(seed.root, approveRequest(seed.staged, runtimeOf([], { source: source() })), "cancellation");
  return { memory, disk, memoryRun: stores.current(), diskRun: await readStagedRun(seed.root, seed.staged), log };
}

describe("compensation over the run stores", () => {
  it("K1 compensates the applied mutation in reverse to the same signed run as the root form, removing the advisory last", async () => {
    const seed = await copiedProject(tracker, parkedMidApply);
    const { memory, disk, memoryRun, diskRun, log } = await bothWays(seed, compensateOperationBundleWith, compensateOperationBundleLocked);
    expect([memory, memoryRun]).toEqual([disk, diskRun]);
    expect([memory.state, log]).toEqual(["compensated", ["manifest", "key", "run", "compensation-began", "compensation-started",
      "evidence source-retain", "compensation-completed", "compensated", "cancel removed"]]);
  });

  it("K2 parks without compensating on drift, a missing compensator or a moved post-state, and leaves a non-parked run alone", async () => {
    const seed = await copiedProject(tracker, parkedMidApply);
    const gates = [{ authority: drifted }, { source: unboundSourceAdapter() }, { source: compensatingSourceAdapter() }];
    for (const over of gates) {
      const log: string[] = [];
      const result = await compensateOperationBundleWith(memoryRunStores(seed, log), approveRequest(seed.staged, runtimeOf([], over as never)), "apply-failure");
      expect([result.problems.map(({ code }) => code), log]).toEqual([["bundle-recovery-required"], ["manifest", "key", "run"]]);
    }
    const fresh = await copiedProject(tracker, (root) => stageSourceBundle(root));
    const log: string[] = [];
    const untouched = await compensateOperationBundleWith(memoryRunStores(fresh, log), approveRequest(fresh.staged, runtimeOf([])), "cancellation");
    expect([untouched.state, untouched.problems, log]).toEqual(["awaiting-approval", [], ["manifest", "key", "run"]]);
  });
});

describe("crash recovery and operator resume over the run stores", () => {
  it("V1 resumes a parked run forward to the same signed run as the root form", async () => {
    const seed = await copiedProject(tracker, (root) => parkedSourceBundle(root));
    const log: string[] = [];
    const stores = memoryRunStores(seed, log);
    const memory = await resumeOperationRecoveryWith(stores, approveRequest(seed.staged, runtimeOf([])));
    const disk = await resumeOperationRecoveryLocked(seed.root, approveRequest(seed.staged, runtimeOf([])));
    expect([memory, stores.current()]).toEqual([disk, await readStagedRun(seed.root, seed.staged)]);
    expect([memory.state, log]).toEqual(["succeeded", ["manifest", "key", "run", "recovery-resumed", "cancel?", "mutation-started",
      "evidence source-retain", "mutation-applied", "succeeded", "cancel removed"]]);
  });

  it("V2 resume refuses a missing grant and drift without a transition; recovery leaves a non-applying run alone", async () => {
    const seed = await copiedProject(tracker, (root) => parkedSourceBundle(root));
    const run = async (request: Parameters<typeof resumeOperationRecoveryWith>[1], body = resumeOperationRecoveryWith) => {
      const log: string[] = [];
      const result = await body(memoryRunStores(seed, log), request);
      return [result.state, result.problems.map(({ code }) => code), log];
    };
    const reads = ["manifest", "key", "run"];
    expect(await run(approveRequest(seed.staged, runtimeOf([]), []))).toEqual(["recovery-required", ["approval-grant-missing"], reads]);
    expect(await run(approveRequest(seed.staged, runtimeOf([], { authority: drifted as never })))).toEqual(["recovery-required", ["approval-invalidated"], reads]);
    expect(await run(approveRequest(seed.staged, runtimeOf([])), recoverOperationRunWith)).toEqual(["recovery-required", [], reads]);
  });
});

/** Recovery-plan steps over memory run stores (keyed by bundle), with staging and the recovered writer logged. */
function planSteps(log: string[], seeds: readonly CopiedProject[]): RecoveryPlanSteps {
  const byBundle = (bundleId: string) => seeds.find((seed) => seed.staged.bundleId === bundleId)!;
  return {
    readManifest: async (_ws, bundleId) => { log.push(`manifest ${seeds.indexOf(byBundle(bundleId))}`); return byBundle(bundleId).manifest; },
    readKey: async () => { log.push("key"); return seeds[0]!.key; },
    readRun: async (binding) => { log.push(`run ${seeds.indexOf(byBundle(binding.bundleId))}`); return { status: "ok", run: byBundle(binding.bundleId).run }; },
    stage: async (request) => { log.push(`stage ${request.draft.recoversBundleId === seeds[0]!.staged.bundleId}`); return { status: "staged" } as never; },
    appendRecovered: async (_binding, _expected, input) => { log.push(`recovered ${input.recoveryBinding.bundleId === seeds[1]?.staged.bundleId}`); return seeds[0]!.run; },
  };
}

/** A plan request for the parked `seed`, with `grants`. */
const planRequest = (seed: CopiedProject, grants = ["operation-bundle.approve"]): RecoveryPlanRequest => ({
  workspaceId: seed.staged.workspaceId, originalBundleId: seed.staged.bundleId, originalManifestDigest: seed.staged.manifestDigest,
  principal: { id: "operator", surface: "cli", grants: grants as never }, actionInput: { reason: "retry" },
});

describe("recovery planning and settlement over their steps", () => {
  it("P1 plans only with the grant and from a parked original, handing the planner's draft to staging", async () => {
    const parked = await copiedProject(tracker, (root) => parkedSourceBundle(root));
    const fresh = await copiedProject(tracker, (root) => stageSourceBundle(root));
    const log: string[] = [];
    await expect(planRecoveryBundleWith(planSteps(log, [parked]), planRequest(parked, []), sourceRecoveryPlanner())).rejects.toThrow("recovery planning requires the approve grant");
    await expect(planRecoveryBundleWith(planSteps(log, [fresh]), planRequest(fresh), sourceRecoveryPlanner())).rejects.toThrow("original run is not recovery-required");
    expect(log).toEqual(["manifest 0", "key", "run 0"]);
    log.length = 0;
    await planRecoveryBundleWith(planSteps(log, [parked]), planRequest(parked), sourceRecoveryPlanner());
    expect(log).toEqual(["manifest 0", "key", "run 0", "stage true"]);
  });

  it("P2 settles only a parked original from a successful recovery run, appending the recovered transition", async () => {
    const parked = await copiedProject(tracker, (root) => parkedSourceBundle(root));
    const pending = await copiedProject(tracker, (root) => stageSourceBundle(root));
    const settle = async (seeds: CopiedProject[], recovery: CopiedProject) => {
      const log: string[] = [];
      const request = { ...planRequest(seeds[0]!), recoveryBundleId: recovery.staged.bundleId, recoveryManifestDigest: recovery.staged.manifestDigest, at: "2026-07-19T00:00:02.000Z" };
      const result = await settleOriginalFromRecoveryWith(planSteps(log, seeds), request);
      return [result.problems.map(({ code }) => code), log];
    };
    expect(await settle([pending, parked], parked)).toEqual([[], ["manifest 0", "key", "run 0"]]);
    expect(await settle([parked, pending], pending)).toEqual([["bundle-recovery-required"], ["manifest 0", "key", "run 0", "manifest 1", "key", "run 1"]]);
    const succeeded = { ...pending, run: { ...pending.run, state: "succeeded" } } as CopiedProject;
    expect(await settle([parked, succeeded], succeeded)).toEqual([[], ["manifest 0", "key", "run 0", "manifest 1", "key", "run 1", "recovered true"]]);
  });

  it("Z1 the root forms reach the staging transaction and the recovered writer with the root and the body's arguments", async () => {
    const parked = await copiedProject(tracker, (root) => parkedSourceBundle(root));
    const staging = vi.spyOn(stage, "stageOperationBundleLocked").mockResolvedValue({ status: "staged" } as never);
    await planRecoveryBundleLocked(parked.root, planRequest(parked), sourceRecoveryPlanner());
    expect(staging.mock.calls.map((call) => [call[0], call[1].draft.recoversBundleId])).toEqual([[parked.root, parked.staged.bundleId]]);
    staging.mockRestore();
    const done = await stageSourceBundle(parked.root, Buffer.from("a recovery that succeeded\n"));
    vi.spyOn(runStore, "readOperationRun").mockImplementation(async (_root, binding) => ({ status: "ok", run: binding.bundleId === done.bundleId ? { ...parked.run, state: "succeeded" } : parked.run }));
    const recovered = vi.spyOn(runStore, "appendRecoveredTransitionLocked").mockResolvedValue(parked.run);
    const request = { ...planRequest(parked), recoveryBundleId: done.bundleId, recoveryManifestDigest: done.manifestDigest, at: "2026-07-19T00:00:02.000Z" };
    await settleOriginalFromRecoveryLocked(parked.root, request);
    expect(recovered.mock.calls.map((call) => [call[0], call[1].bundleId, call[3].recoveryBinding.bundleId])).toEqual([[parked.root, parked.staged.bundleId, done.bundleId]]);
  });
});
