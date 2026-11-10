/**
 * @file test/storage/operation-recovery-binding.test.ts
 * @description The bundle-recovery decisions over explicit DOMAIN reads: the
 * gate's bundle-recovery leg (`detectBundleRecoveryFrom`) and the read-only
 * resolver behind `llmwiki operation list` (`resolveOperationRecoveryStateFrom`),
 * each ONE body over {@link OperationRecoveryReads} (inventory, key, one run). The
 * production default is `diskOperationRecoveryReads`, the local-disk adapter.
 *
 * HOW IT IS BUILT. Real projects are staged on disk with the existing operation
 * fixtures (`executor-fixtures.ts`): clean, a staged bundle (pre-effect
 * `awaiting-approval`), a parked bundle (`recovery-required`), a crash-interrupted
 * apply (stale `applying`), and a staged bundle whose operation key was removed
 * (its run leaf can then no longer authenticate, so the INVENTORY reports a problem).
 * The ROOT gate and ROOT resolver are the controls; the bodies over the disk
 * adapter must agree with them.
 *
 * WHAT IS MEMORY ONLY. The memory cases replay DOMAIN SNAPSHOTS captured from those
 * real reads (an inventory, a key, and run reads in call order) through a scripted
 * double, to pin the decision order: the empty-inventory short circuit, first-block
 * semantics, unreadable-run codes and parked-versus-stale precedence. A snapshot is
 * not copied-byte physical proof; the store walk and the confined key and run leaf
 * reads beneath the three domain reads stay root-bound and are not exercised here.
 */

import { rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as capacity from "../../src/operation-bundles/capacity.js";
import type { OperationInventory } from "../../src/operation-bundles/capacity.js";
import { approveAndApplyOperationBundleLocked } from "../../src/operation-bundles/executor.js";
import * as keyEpoch from "../../src/operation-bundles/key-epoch.js";
import type { OperationKeyRead } from "../../src/operation-bundles/key-epoch.js";
import {
  acquireMutationLock, detectBundleRecoveryFrom, diskOperationRecoveryReads, RecoveryGateError,
  resolveOperationRecoveryState, resolveOperationRecoveryStateFrom, type OperationRecoveryReads,
} from "../../src/operation-bundles/lock-gate.js";
import * as runStore from "../../src/operation-bundles/run-store.js";
import type { OperationRunRead } from "../../src/operation-bundles/run-store.js";
import { releaseLock } from "../../src/utils/lock.js";
import { tempRootTracker } from "../temp-roots.js";
import { approveRequest, buildRuntime, parkedSourceBundle, stageSourceBundle } from "../operation-bundles/executor-fixtures.js";

const PREFIX = "operation-recovery-binding-";
/** The project-global operation key leaf (`key-epoch.ts`). */
const KEY_LEAF = path.join(".llmwiki", "operation-bundles.runkey");

/** One project's three domain reads, as the real disk adapter answered them, plus the root resolver's verdict. */
interface Snapshot { root: string; inventory: OperationInventory; key: OperationKeyRead; runs: OperationRunRead[]; resolved: string }

type Scenario = "clean" | "staged" | "parked" | "stale" | "keyless";
const MINTS: Record<Scenario, (root: string) => Promise<unknown>> = {
  clean: async () => {},
  staged: (root) => stageSourceBundle(root),
  parked: (root) => parkedSourceBundle(root),
  stale: async (root) => {
    const staged = await stageSourceBundle(root);
    const crashing = buildRuntime({ fault: { async afterApply() { throw new Error("crash"); } } });
    await approveAndApplyOperationBundleLocked(root, approveRequest(staged, crashing)).catch(() => undefined);
  },
  keyless: async (root) => { await stageSourceBundle(root); await rm(path.join(root, KEY_LEAF)); },
};

/** Capture one project's domain reads through the real adapter, recording every run read in call order. */
async function capture(root: string): Promise<Snapshot> {
  const disk = diskOperationRecoveryReads(root);
  const runs: OperationRunRead[] = [];
  const recorder: OperationRecoveryReads = { ...disk, readRun: async (binding) => { const read = await disk.readRun(binding); runs.push(read); return read; } };
  await resolveOperationRecoveryStateFrom(recorder);
  return { root, inventory: await disk.scanInventory(), key: await disk.readKey(), runs, resolved: await resolveOperationRecoveryState(root) };
}

const tracker = tempRootTracker();
const snapshots = new Map<Scenario, Snapshot>();
const snapshotOf = (name: Scenario): Snapshot => { const held = snapshots.get(name); if (!held) throw new Error(`${name} not minted`); return held; };
beforeAll(async () => {
  for (const name of Object.keys(MINTS) as Scenario[]) {
    const root = await tracker.create(PREFIX);
    await MINTS[name](root);
    snapshots.set(name, await capture(root));
  }
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => tracker.cleanup());

/** A scripted DOMAIN double: the inventory and key as given, run reads answered in call order; every read logged. */
function scripted(inventory: OperationInventory, key: OperationKeyRead, runs: readonly OperationRunRead[], log: string[]): OperationRecoveryReads {
  let next = 0;
  return {
    scanInventory: async () => { log.push("inventory"); return inventory; },
    readKey: async () => { log.push("key"); return key; },
    readRun: async () => { log.push(`run ${next}`); const read = runs[next++]; if (!read) throw new Error("unscripted run read"); return read; },
  };
}

/** The one manifest a staged project holds, `count` times over (the double answers by call order, not binding). */
const manifestsOf = (name: Scenario, count: number): OperationInventory => {
  const { inventory } = snapshotOf(name);
  return { ...inventory, manifests: Array.from({ length: count }, () => inventory.manifests[0]!) };
};
const runOf = (name: Scenario): OperationRunRead => snapshotOf(name).runs[0]!;
const UNREADABLE: OperationRunRead = { status: "unavailable", detail: "run leaf unreadable" };

describe("both decision bodies over the real local-disk adapter, against the ROOT controls", () => {
  it("R1 lets a clean and a staged (pre-effect) project through: no block, resolver clean, the ROOT gate acquires", async () => {
    for (const name of ["clean", "staged"] as const) {
      const { root, resolved } = snapshotOf(name);
      expect([await detectBundleRecoveryFrom(diskOperationRecoveryReads(root)), await resolveOperationRecoveryStateFrom(diskOperationRecoveryReads(root)), resolved])
        .toEqual([null, "clean", "clean"]);
      expect(await acquireMutationLock(root, "ordinary")).toBe(true);
      await releaseLock(root);
    }
    expect([snapshotOf("clean").inventory.manifests.length, snapshotOf("staged").runs.map((read) => read.status === "ok" && read.run.state)]).toEqual([0, ["awaiting-approval"]]);
  });

  it("R2 blocks a parked bundle (required) and a stale applying one (stale-pending); the ROOT gate refuses the parked one with the same code", async () => {
    const decide = async (name: Scenario) => [await detectBundleRecoveryFrom(diskOperationRecoveryReads(snapshotOf(name).root)), snapshotOf(name).resolved];
    expect([await decide("parked"), await decide("stale")]).toEqual([
      ["bundle-recovery-blocking", "bundle-recovery-required"], ["bundle-recovery-blocking", "applying-stale-recovery-pending"],
    ]);
    const refusal = await acquireMutationLock(snapshotOf("parked").root, "ordinary").then(() => null, (error: unknown) => error);
    expect([refusal instanceof RecoveryGateError, refusal instanceof RecoveryGateError && refusal.code]).toEqual([true, "bundle-recovery-blocking"]);
  });

  it("R3 fails closed on a removed key: the unauthenticable run is an inventory problem, so both block before the key branch", async () => {
    const { root, key, inventory, resolved } = snapshotOf("keyless");
    expect([key.status, inventory.problems.length > 0, await detectBundleRecoveryFrom(diskOperationRecoveryReads(root)), resolved])
      .toEqual(["absent", true, "bundle-recovery-blocking", "bundle-recovery-required"]);
  });
});

describe("the decision order over replayed domain snapshots (memory only, not physical proof)", () => {
  it("R4 short-circuits an empty inventory before the key, and blocks on inventory problems before the key", async () => {
    const { inventory, key } = snapshotOf("staged");
    const log: string[] = [];
    const empty = { ...inventory, manifests: [] };
    const broken = { ...inventory, problems: [{ dimension: "orphan", detail: "unexpected leaf" }] };
    expect([await detectBundleRecoveryFrom(scripted(empty, key, [], log)), await resolveOperationRecoveryStateFrom(scripted(empty, key, [], log))]).toEqual([null, "clean"]);
    expect([await detectBundleRecoveryFrom(scripted(broken, key, [], log)), await resolveOperationRecoveryStateFrom(scripted(broken, key, [], log))])
      .toEqual(["bundle-recovery-blocking", "bundle-recovery-required"]);
    expect(log).toEqual(["inventory", "inventory", "inventory", "inventory"]);
  });

  it("R5 keeps the key distinctions (missing vs unreadable for the gate; required for the resolver), each before any run read", async () => {
    const log: string[] = [];
    const inventory = manifestsOf("staged", 1);
    const decide = async (key: OperationKeyRead) => [await detectBundleRecoveryFrom(scripted(inventory, key, [], log)), await resolveOperationRecoveryStateFrom(scripted(inventory, key, [], log))];
    expect([await decide({ status: "absent" }), await decide({ status: "unavailable" })])
      .toEqual([["integrity-key-missing", "bundle-recovery-required"], ["integrity-key-unreadable", "bundle-recovery-required"]]);
    expect(log).toEqual(["inventory", "key", "inventory", "key", "inventory", "key", "inventory", "key"]);
  });

  it("R6 lets the FIRST blocking run win in manifest order, and reports an unreadable run's own code or run-integrity-invalid", async () => {
    const { key } = snapshotOf("staged");
    const decide = async (runs: OperationRunRead[]) => { const log: string[] = []; return [await detectBundleRecoveryFrom(scripted(manifestsOf("staged", runs.length), key, runs, log)), log.length - 2]; };
    expect(await decide([runOf("parked"), runOf("staged")])).toEqual(["bundle-recovery-blocking", 1]);
    expect(await decide([runOf("staged"), runOf("stale")])).toEqual(["bundle-recovery-blocking", 2]);
    expect(await decide([UNREADABLE, runOf("parked")])).toEqual(["run-integrity-invalid", 1]);
    expect(await decide([{ status: "unavailable", detail: "run leaf unreadable", code: "integrity-key-unreadable" }])).toEqual(["integrity-key-unreadable", 1]);
    expect(await decide([runOf("staged"), runOf("staged")])).toEqual([null, 2]);
  });

  it("R7 keeps the resolver's precedence: unreadable or stale returns at its position, parked only marks, so a later stale run wins", async () => {
    const { key } = snapshotOf("staged");
    const resolve = async (runs: OperationRunRead[]) => { const log: string[] = []; return [await resolveOperationRecoveryStateFrom(scripted(manifestsOf("staged", runs.length), key, runs, log)), log.length - 2]; };
    expect(await resolve([runOf("parked"), runOf("stale")])).toEqual(["applying-stale-recovery-pending", 2]);
    expect(await resolve([runOf("stale"), runOf("parked")])).toEqual(["applying-stale-recovery-pending", 1]);
    expect(await resolve([runOf("parked"), runOf("staged")])).toEqual(["bundle-recovery-required", 2]);
    expect(await resolve([UNREADABLE, runOf("stale")])).toEqual(["bundle-recovery-required", 1]);
    expect(await resolve([runOf("staged"), { status: "absent" }])).toEqual(["clean", 2]);
  });

  it("R8 makes no ambient read in the bound bodies, while the ROOT resolver reaches all three incumbent reads at their import sites", async () => {
    const spies = [vi.spyOn(capacity, "scanOperationInventory"), vi.spyOn(keyEpoch, "readOperationKey"), vi.spyOn(runStore, "readOperationRun")];
    const { inventory, key, runs } = snapshotOf("parked");
    expect(await resolveOperationRecoveryStateFrom(scripted(inventory, key, runs, []))).toBe("bundle-recovery-required");
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
    expect(await resolveOperationRecoveryState(snapshotOf("parked").root)).toBe("bundle-recovery-required");
    expect(spies.map((spy) => spy.mock.calls.length > 0)).toEqual([true, true, true]);
  });
});
