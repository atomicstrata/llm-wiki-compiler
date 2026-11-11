/**
 * @file test/storage/lifecycle-driver-binding.test.ts
 * @description The custody driver's phases as ONE body over
 * `LifecycleDriverSteps` (`runLifecycleCustodyOperationWith`): the read lease
 * and the three custody engines, with the project root only an opaque handle.
 *
 * HOW IT IS BUILT. Memory steps and a memory adapter log every call. They pin
 * the phase order (one capture, assess inside it, permit and materialize after
 * it, the engine chosen by plan kind, complete only after the engine's receipt),
 * that a reauthorization divergence refuses before assess, that a planKind
 * mismatch refuses before the permit and materialize, that the plan handed to
 * materialize is already sealed, that an engine fault never reaches complete,
 * and that the in-flight guard, keyed on the SUPPLIED root identity, still
 * refuses a second operation on the same project. The root form is shown
 * handing the incumbent identity, lease and engine the root.
 *
 * NOT SHOWN HERE: the adapters' assessments, the read lease and the engines
 * themselves; `lifecycle-driver.test.ts` and the custody suites show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import {
  runLifecycleCustodyOperation, runLifecycleCustodyOperationWith, type LifecycleCustodyAdapter, type LifecycleCustodyPlan,
  type LifecycleCustodyRequest, type LifecycleDriverSteps, type LifecyclePlanKind,
} from "../../src/preparations/lifecycle-driver.js";
import * as namespace from "../../src/preparations/lifecycle-fs/namespace.js";
import * as lifecycleRead from "../../src/preparations/lifecycle-snapshot/read.js";
import * as quarantineMove from "../../src/preparations/quarantine-move.js";

afterEach(() => { vi.restoreAllMocks(); });

const ROOT = "/memory/project";
const KEY = { key: Buffer.from("k"), keyEpochId: "epoch-1" };
/** A settled quarantine receipt with the fields the driver seals (objects, actor); the rest is not consulted here. */
const SETTLED = { receipt: "settled", objects: [], actor: { id: "operator", surface: "cli" } } as never;
const INPUT: LifecycleCustodyRequest = { actor: { id: "operator", surface: "cli" } as never, at: "2026-08-01T00:00:00.000Z", authorization: "ungated" };
const DRAFTS: { [K in LifecyclePlanKind]: Extract<LifecycleCustodyPlan, { kind: K }> } = {
  "custody-move": { kind: "custody-move", unitId: "u1", scope: "run" as never, reason: "operator" as never, objects: [], residualObligations: [] },
  "verified-delete": { kind: "verified-delete", unitId: "u1", operation: "prune" as never, objects: [] },
  "verified-destroy": { kind: "verified-destroy", unitId: "u1", objects: [] as never, settled: SETTLED },
};

/** Memory identity, lease and engines; each call logged, with the input each engine received kept. */
function stepsOf(log: string[], world: { read?: object; engineFault?: Error; identity?: string } = {}): LifecycleDriverSteps & { inputs: object[] } {
  const inputs: object[] = [];
  const engine = (name: string, receipt: unknown) => async (input: object) => {
    log.push(name); inputs.push(input);
    if (world.engineFault) throw world.engineFault;
    return receipt as never;
  };
  return {
    inputs,
    rootIdentity: async () => { log.push("identity"); return world.identity ?? "memory-project"; },
    async withRead(consume) { log.push("capture"); try { return await consume((world.read ?? { status: "ok" }) as never); } finally { log.push("lease closed"); } },
    moveEngine: engine("move", { receipt: "moved" }), verifiedDeleteEngine: engine("delete", { receipt: "deleted" }), destroyEngine: engine("destroy", undefined),
  };
}

/** A memory adapter declaring `planKind` and drafting `draft`; each phase logged. */
function adapterOf(log: string[], planKind: LifecyclePlanKind, draft: LifecycleCustodyPlan = DRAFTS[planKind]): LifecycleCustodyAdapter<LifecycleCustodyRequest, never> {
  return {
    operation: "quarantine", planKind: planKind as never,
    assess: async (root) => { log.push(`assess ${root}`); return { draft: draft as never, key: KEY }; },
    materialize: async (_root, _input, assessment, permit) => { log.push(`materialize ${permit.unitId} sealed=${Object.isFrozen(assessment.draft)}`); return KEY; },
    complete: async (_root, _input, receipt) => { log.push(`complete ${JSON.stringify(receipt)}`); },
  };
}

describe("the custody driver as a root-free body", () => {
  it("D1 captures once, assesses inside the lease, then permits, materializes, runs the move engine and completes with its receipt", async () => {
    const log: string[] = [];
    const steps = stepsOf(log);
    expect(await runLifecycleCustodyOperationWith(steps, ROOT, adapterOf(log, "custody-move"), INPUT)).toEqual({ receipt: "moved" });
    expect(log).toEqual(["identity", "capture", `assess ${ROOT}`, "lease closed", "materialize u1 sealed=true", "move", 'complete {"receipt":"moved"}']);
    expect(steps.inputs[0]).toMatchObject({ root: ROOT, unitId: "u1", key: KEY.key, keyEpochId: "epoch-1", actor: INPUT.actor, at: INPUT.at });
  });

  it("D2 dispatches by plan kind: delete reaches only the delete engine; destroy reaches only the destroy engine and returns the settled receipt", async () => {
    for (const [kind, engine, receipt] of [["verified-delete", "delete", { receipt: "deleted" }], ["verified-destroy", "destroy", SETTLED]] as const) {
      const log: string[] = [];
      expect(await runLifecycleCustodyOperationWith(stepsOf(log), ROOT, adapterOf(log, kind), INPUT)).toEqual(receipt);
      expect(log.filter((line) => ["move", "delete", "destroy"].includes(line))).toEqual([engine]);
    }
  });

  it("D3 a reauthorization divergence refuses inside the capture, before assess", async () => {
    const log: string[] = [];
    const authorized = { ...INPUT, authorization: { intent: "prune", targetUnitId: "u1", ticket: null } as never };
    await expect(runLifecycleCustodyOperationWith(stepsOf(log, { read: { status: "unavailable", detail: "registry unreadable" } }), ROOT, adapterOf(log, "custody-move"), authorized))
      .rejects.toThrow("destructive authorization no longer holds");
    expect(log).toEqual(["identity", "capture", "lease closed"]);
  });

  it("D4 a declared planKind that is not the drafted kind refuses before the permit and materialize; an engine fault never completes", async () => {
    const log: string[] = [];
    await expect(runLifecycleCustodyOperationWith(stepsOf(log), ROOT, adapterOf(log, "verified-delete", DRAFTS["custody-move"]), INPUT))
      .rejects.toThrow("adapter declared planKind verified-delete and planned custody-move");
    expect(log).toEqual(["identity", "capture", `assess ${ROOT}`, "lease closed"]);
    const faulted: string[] = [];
    await expect(runLifecycleCustodyOperationWith(stepsOf(faulted, { engineFault: new Error("fsync failed") }), ROOT, adapterOf(faulted, "custody-move"), INPUT)).rejects.toThrow("fsync failed");
    expect(faulted.at(-1)).toBe("move");
  });

  it("D5 keeps the in-flight guard on the supplied identity: a second operation on the same project refuses, another project proceeds", async () => {
    let release: () => void = () => {}, entered: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const slow: LifecycleDriverSteps = { ...stepsOf([]), async withRead(consume) { entered(); await gate; return consume({ status: "ok" } as never); } };
    const first = runLifecycleCustodyOperationWith(slow, ROOT, adapterOf([], "custody-move"), INPUT);
    await inside; // the first operation holds the guard: it is inside its capture
    await expect(runLifecycleCustodyOperationWith(stepsOf([]), "/an/alias", adapterOf([], "custody-move"), INPUT)).rejects.toThrow("already in flight for memory-project");
    expect(await runLifecycleCustodyOperationWith(stepsOf([], { identity: "other-project" }), ROOT, adapterOf([], "custody-move"), INPUT)).toEqual({ receipt: "moved" });
    release();
    await first;
  });
});

describe("the root form", () => {
  it("Z1 hands the incumbent identity and lease the root, and the move engine an input carrying it", async () => {
    const identity = vi.spyOn(namespace, "canonicalPreparationRootIdentity");
    const read = vi.spyOn(lifecycleRead, "withPreparationLifecycleRead").mockImplementation(async (_root, consume) => consume({ status: "ok" } as never));
    const move = vi.spyOn(quarantineMove, "runTwoPhaseQuarantine").mockResolvedValue({ receipt: "moved" } as never);
    const log: string[] = [];
    await runLifecycleCustodyOperation(ROOT, adapterOf(log, "custody-move"), INPUT);
    expect([identity.mock.calls, read.mock.calls.map((call) => call[0]), move.mock.calls.map((call) => (call[0] as { root: string }).root), log.at(-1)])
      .toEqual([[[ROOT]], [ROOT], [ROOT], 'complete {"receipt":"moved"}']);
  });
});
