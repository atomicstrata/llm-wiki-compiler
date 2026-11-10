/**
 * @file test/storage/preparation-cancel-settlement-binding.test.ts
 * @description The cancellation settlement as root-free bodies over
 * `CancelSettlementSources`, against the shipped root entries over the same real
 * staged runs: the attempt's whole capture-then-settle sequence
 * (`settleAttemptCancellationWith`), the advisory carry
 * (`carryAdvisoryIntoCancellingWith`), the durable capture
 * (`recordDurableCancellingWith`) and the settlement (`settleCancelledRunWith`).
 *
 * HOW IT IS BUILT. Each case stages a REAL preparation, snapshots its
 * authenticated run, key, manifest and advisory, and only then runs the root
 * entry on disk. The memory sources answer from that snapshot, and every memory
 * append goes through the real authenticated writer (`appendPreparationTransitionWith`)
 * with the real key, so each transition is signed, re-parsed and re-verified, never
 * assumed. The disk run and the memory run must end in the same states,
 * transitions, actors and instants, and the memory log shows the body's order,
 * including the attempt clock read once before each leg.
 *
 * NOT SHOWN HERE: the lock (the caller's), confinement and durability (the local
 * root forms', covered by the incumbent cancel suites).
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import {
  carryAdvisoryIntoCancellingLocked, carryAdvisoryIntoCancellingWith, recordDurableCancellingWith, settleAttemptCancellationLocked,
  settleAttemptCancellationWith, settleCancelledRunLocked, settleCancelledRunWith, type CancelSettlementSources,
} from "../../src/preparations/attempts/cancel-settlement.js";
import * as cancellation from "../../src/preparations/cancellation.js";
import { readPreparationKey } from "../../src/preparations/key-epoch.js";
import * as manifestStore from "../../src/preparations/manifest-store.js";
import { verifyPreparationRunIntegrity } from "../../src/preparations/run-integrity.js";
import { parsePreparationRun } from "../../src/preparations/run-parse.js";
import * as runStore from "../../src/preparations/run-store.js";
import type { PreparationRunBinding, PreparationRunV1 } from "../../src/preparations/run-types.js";
import { attemptRequest, stageRunningPreparation, type StagedPreparation } from "../preparations/attempt-fixture.js";
import { readRun, requestCancel, settlementInput, underLock } from "../preparations/cancel-settlement-fixture.js";
import { stageReadyPreparation } from "../preparations/handoff-fixture.js";
import { externalEffectPlan } from "../preparations/store-fixture.js";

const DECLARED_EFFECT = `sha256:${"a".repeat(64)}`;
/** The project a case runs on: its root and its run's binding. */
type Project = Pick<StagedPreparation, "root" | "binding">;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function running(plan?: unknown): Promise<StagedPreparation> {
  const staged = await (plan === undefined ? stageRunningPreparation() : stageRunningPreparation(plan));
  cleanups.push(staged.cleanup);
  return staged;
}

/** The memory project: the current authenticated run, the advisory's presence, and every source call in order. */
interface Memory { run: PreparationRunV1; advisory: boolean; log: string[] }

/** Snapshot `project` from disk, and the memory sources over that snapshot; appends are authenticated with the real key. */
async function memoryOf(project: Project) {
  const { root, binding } = project;
  const key = await readPreparationKey(root);
  if (key.status !== "ok") throw new Error("fixture key unavailable");
  const manifest = await manifestStore.readPreparationManifest(root, binding.workspaceId, binding.preparationId);
  const run = await runStore.readPreparationRun(root, binding);
  if (run.status !== "ok") throw new Error("fixture run unavailable");
  const memory: Memory = { run: run.run, advisory: await cancellation.preparationCancellationRequested(root, binding.workspaceId, binding.runId), log: [] };
  const writes: runStore.PreparationRunWriteSteps = {
    readRun: async () => ({ status: "ok", run: memory.run }), readKey: async () => key,
    readEvidence: async () => { throw new Error("a cancel settlement reads no evidence"); },
    publishGenesis: async () => { throw new Error("a cancel settlement writes no genesis"); },
    replaceRun: async (bound, serialized) => { memory.run = parsePreparationRun(serialized, bound); },
  };
  const sources: CancelSettlementSources = {
    readRun: async () => { memory.log.push("readRun"); return { status: "ok", run: memory.run }; },
    readManifest: async () => { memory.log.push("readManifest"); return manifest; },
    appendTransition: async (bound, expected, input) => { memory.log.push(`append ${input.type}`); return runStore.appendPreparationTransitionWith(writes, bound, expected, input); },
    cancellationRequested: async () => { memory.log.push("advisory"); return memory.advisory; },
    removeCancel: async () => { memory.log.push("remove"); memory.advisory = false; },
  };
  return { sources, memory, key: key.key };
}

/** What two runs must agree on: state, version, and each transition's type, edge, actor, instant and payload. */
const shape = (run: PreparationRunV1) => ({ state: run.state, stateVersion: run.stateVersion,
  transitions: run.transitions.map(({ type, stateBefore, stateAfter, actor, at, payload }) => ({ type, stateBefore, stateAfter, actor, at, payload })) });
const advisoryOnDisk = (project: Project) => cancellation.preparationCancellationRequested(project.root, project.binding.workspaceId, project.binding.runId);

/** Run the attempt's settlement on disk and in memory from the same snapshot; the memory clock logs each read. */
async function attemptParity(staged: StagedPreparation, delivered: boolean) {
  const { sources, memory, key } = await memoryOf(staged);
  await underLock(staged.root, () => settleAttemptCancellationLocked(attemptRequest(staged), delivered));
  const request = attemptRequest(staged);
  const clock = { now: () => { memory.log.push("clock"); return request.clock.now(); } };
  await settleAttemptCancellationWith(sources, { ...request, clock }, delivered);
  const disk = await readRun(staged);
  expect([shape(memory.run), memory.advisory, verifyPreparationRunIntegrity(memory.run, key, staged.binding)])
    .toEqual([shape(disk), await advisoryOnDisk(staged), true]);
  return { memory, disk, sources };
}

const SETTLE = ["clock", "readRun", "append cancelling", "clock", "readRun", "readManifest"];

describe("the cancellation settlement as root-free bodies, against the root entries over real runs", () => {
  it("C1 captures and settles an effect-free run with an advisory to cancelled, consuming the advisory, as the disk did", async () => {
    const staged = await running();
    await requestCancel(staged);
    const { memory, disk } = await attemptParity(staged, false);
    expect([disk.state, disk.transitions.at(-2)?.type, memory.advisory]).toEqual(["cancelled", "cancelling", false]);
    expect(memory.log).toEqual(["advisory", ...SETTLE, "append cancelled", "remove"]);
  });

  it("C2 honours a delivered cancel with no advisory without reading the advisory, as the disk did", async () => {
    const { memory, disk } = await attemptParity(await running(), true);
    expect(disk.state).toBe("cancelled");
    expect(memory.log).toEqual([...SETTLE, "append cancelled", "remove"]);
  });

  it("C3 parks an effect-capable cancelling run with the cancel code, still consuming the captured advisory, as the disk did", async () => {
    const staged = await running(externalEffectPlan(DECLARED_EFFECT));
    await requestCancel(staged);
    const { memory, disk } = await attemptParity(staged, false);
    expect([disk.state, disk.transitions.at(-1)?.payload]).toEqual(["recovery-required", { kind: "problem", code: "preparation-cancellation-effect-unproven" }]);
    expect(memory.log).toEqual(["advisory", ...SETTLE, "append recovery-required", "remove"]);
  });

  it("C4 carries an advisory over a handoff-ready run into cancelling, and refuses a running run before asking the advisory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "prep-cancel-carry-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const ready = { root, binding: await stageReadyPreparation(root) } as StagedPreparation;
    await requestCancel(ready);
    const { sources, memory } = await memoryOf(ready);
    expect(await underLock(root, () => carryAdvisoryIntoCancellingLocked(settlementInput(ready)))).toBe(true);
    expect(await carryAdvisoryIntoCancellingWith(sources, settlementInput(ready))).toBe(true);
    expect([shape(memory.run), memory.log]).toEqual([shape(await readRun(ready)), ["readRun", "advisory", "append cancelling"]]);
    const busyStaged = await running();
    const busy = await memoryOf(busyStaged);
    expect([await carryAdvisoryIntoCancellingWith(busy.sources, settlementInput(busyStaged)), busy.memory.log]).toEqual([false, ["readRun"]]);
  });

  it("C5 re-drives a terminal without writing, and refuses a plan whose digest is not the binding's", async () => {
    const staged = await running();
    const { sources, memory } = await attemptParity(staged, true);
    memory.log.length = 0;
    expect(await settleCancelledRunWith(sources, settlementInput(staged))).toEqual({ status: "settled", state: "cancelled" });
    const freshStaged = await running();
    const fresh = await memoryOf(freshStaged);
    expect(await recordDurableCancellingWith(fresh.sources, settlementInput(freshStaged))).toBe(true);
    const swapped: PreparationRunBinding = { ...freshStaged.binding, manifestDigest: parseSha256Digest(`sha256:${"0".repeat(64)}`) };
    expect(await settleCancelledRunWith(fresh.sources, { ...settlementInput(freshStaged), binding: swapped }))
      .toEqual({ status: "unavailable", detail: "manifest-unavailable" });
    expect([memory.log, fresh.memory.log]).toEqual([["readRun"], ["readRun", "append cancelling", "readRun", "readManifest"]]);
  });

  it("C6 makes no ambient call from the bodies, while the root entries reach every incumbent with exact arguments", async () => {
    const staged = await running();
    await requestCancel(staged);
    const { sources } = await memoryOf(staged);
    const spies = [vi.spyOn(runStore, "readPreparationRun"), vi.spyOn(manifestStore, "readPreparationManifest"), vi.spyOn(runStore, "appendPreparationTransitionLocked"),
      vi.spyOn(cancellation, "preparationCancellationRequested"), vi.spyOn(cancellation, "removePreparationCancelLocked")];
    await settleAttemptCancellationWith(sources, attemptRequest(staged), false);
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0]);
    const { root, binding } = staged;
    await underLock(root, () => settleAttemptCancellationLocked(attemptRequest(staged), false));
    expect(spies[0]).toHaveBeenCalledWith(root, binding);
    expect(spies[1]).toHaveBeenCalledWith(root, binding.workspaceId, binding.preparationId);
    expect(spies[2].mock.calls.map((call) => [call[0], call[1], (call[3] as { type: string }).type])).toEqual([[root, binding, "cancelling"], [root, binding, "cancelled"]]);
    expect([spies[3].mock.calls, spies[4].mock.calls]).toEqual([[[root, binding.workspaceId, binding.runId]], [[root, binding.workspaceId, binding.runId]]]);
    expect(await settleCancelledRunLocked(settlementInput(staged))).toEqual({ status: "settled", state: "cancelled" });
  });
});
