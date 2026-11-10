/**
 * @file test/storage/operation-observe-binding.test.ts
 * @description The bundle observation and the record-preparation lock as ONE
 * body each, over steps that take no project root:
 * `observeOperationBundleWith(OperationObservationReads)` and
 * `withRecordPreparationLockWith(RecordPreparationLock)`.
 *
 * HOW IT IS BUILT. Real bundles are staged (and one applied) on disk with the
 * existing fixtures. Their inventory, key, run and page samples are read there
 * once and answered from memory, so the body over memory must observe exactly
 * what the public root form observes on disk. Memory reads that log every call
 * pin the ladder: inventory faults are uncertainty, an unknown digest is absent,
 * then the key, the run and the pages. The lock body's grant, busy and release
 * order is pinned over a logging lock. The last case shows that neither body
 * makes a root-form call, and that the root forms reach each incumbent with
 * exact arguments.
 *
 * NOT SHOWN HERE: the inventory scan, run authentication, confined page reads
 * and the project lock themselves; their suites show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as shared from "../../src/operation-bundles/adapters/shared.js";
import * as capacity from "../../src/operation-bundles/capacity.js";
import { approveAndApplyOperationBundleLocked } from "../../src/operation-bundles/executor.js";
import * as keyEpoch from "../../src/operation-bundles/key-epoch.js";
import * as lockGate from "../../src/operation-bundles/lock-gate.js";
import { observeOperationBundle, observeOperationBundleWith, type OperationObservationReads } from "../../src/operation-bundles/observe.js";
import { diskRecordPreparationLock, withRecordPreparationLockWith, type RecordPreparationLock } from "../../src/operation-bundles/record-authority.js";
import * as runStore from "../../src/operation-bundles/run-store.js";
import type { PageOperationMutation } from "../../src/operation-bundles/types.js";
import * as lock from "../../src/utils/lock.js";
import {
  approveRequest, buildRuntime, readStagedRun, stagePageUpdateBundle, stageSourceBundle, type StagedBundle,
} from "../operation-bundles/executor-fixtures.js";
import { tempRootTracker } from "../temp-roots.js";

const tracker = tempRootTracker();
afterEach(async () => { vi.restoreAllMocks(); await tracker.cleanup(); });

/** A staged project with what the observation reads there, captured once. */
async function observed(stage: (root: string) => Promise<StagedBundle>, apply = false) {
  const root = await tracker.create("operation-observe-", { real: true });
  const staged = await stage(root);
  if (apply) await approveAndApplyOperationBundleLocked(root, approveRequest(staged, buildRuntime()));
  const inventory = await capacity.scanOperationInventory(root);
  const key = await keyEpoch.readOperationKey(root);
  const run = await readStagedRun(root, staged);
  const manifest = inventory.manifests.find((item) => item.bundleId === staged.bundleId)!;
  const pages = new Map(await Promise.all(manifest.mutations.filter((m): m is PageOperationMutation => m.kind === "page")
    .map(async (mutation) => [mutation.mutationId, await shared.readPageDigest(root, mutation)] as const)));
  return { root, staged, inventory, key, run, pages };
}

/** Memory reads answering the captured project, or what `world` names instead; each call logged. */
function memoryReads(seed: Awaited<ReturnType<typeof observed>>, log: string[], world: Partial<{ [K in keyof OperationObservationReads]: Awaited<ReturnType<OperationObservationReads[K]>> | Error }> = {}): OperationObservationReads {
  const answer = <T>(value: T | Error | undefined, fallback: T): T => { if (value instanceof Error) throw value; return value ?? fallback; };
  return {
    scanInventory: async () => { log.push("inventory"); return answer(world.scanInventory, seed.inventory); },
    readKey: async () => { log.push("key"); return answer(world.readKey, seed.key); },
    readRun: async () => { log.push("run"); return answer(world.readRun, { status: "ok", run: seed.run }); },
    readPageDigest: async (mutation) => { log.push(`page ${mutation.target.slug}`); return answer(world.readPageDigest, seed.pages.get(mutation.mutationId)!); },
  };
}

describe("the bundle observation as a root-free body", () => {
  it("O1 observes a staged page bundle and an applied source bundle exactly as the public root form does on disk", async () => {
    for (const seed of [await observed((root) => stagePageUpdateBundle(root, "concepts", "p", Buffer.from("a\n"), Buffer.from("b\n"))), await observed((root) => stageSourceBundle(root), true)]) {
      const log: string[] = [];
      const memory = await observeOperationBundleWith(memoryReads(seed, log), seed.staged.manifestDigest);
      expect(memory).toEqual(await observeOperationBundle(seed.root, seed.staged.manifestDigest));
      expect(memory.status).toBe("observed");
      expect(log).toEqual(["inventory", "key", "run", ...(seed.pages.size === 1 ? ["page p"] : [])]);
    }
  });

  it("O2 stops at each rung, reading nothing after it, and turns any fault into uncertainty", async () => {
    const seed = await observed((root) => stageSourceBundle(root));
    const run = async (world: Parameters<typeof memoryReads>[2], digest: string = seed.staged.manifestDigest) => {
      const log: string[] = [];
      return [await observeOperationBundleWith(memoryReads(seed, log, world), digest), log];
    };
    expect(await run({ scanInventory: { ...seed.inventory, problems: [{}] } as never })).toEqual([{ status: "unavailable", detail: "operation inventory unavailable" }, ["inventory"]]);
    expect(await run({}, `sha256:${"0".repeat(64)}`)).toEqual([{ status: "absent" }, ["inventory"]]);
    expect(await run({ readKey: { status: "absent" } })).toEqual([{ status: "unavailable", detail: "operation key absent" }, ["inventory", "key"]]);
    expect(await run({ readRun: { status: "absent" } })).toEqual([{ status: "absent" }, ["inventory", "key", "run"]]);
    expect(await run({ readRun: { status: "unavailable", detail: "run tampered" } })).toEqual([{ status: "unavailable", detail: "run tampered" }, ["inventory", "key", "run"]]);
    expect(await run({ readKey: new Error("EIO") })).toEqual([{ status: "unavailable", detail: "operation observation unavailable" }, ["inventory", "key"]]);
  });
});

/** A logging lock that answers `taken`. */
const lockOf = (log: string[], taken = true): RecordPreparationLock => ({
  acquire: async () => { log.push("acquire"); return taken; }, release: async () => { log.push("release"); },
});

describe("the record-preparation lock as a root-free body", () => {
  it("L1 refuses a missing grant before the lock, a busy lock without releasing, and releases after the action either way", async () => {
    const principal = { id: "host", surface: "sdk", grants: ["operation-bundle.prepare"] } as never;
    const log: string[] = [];
    await expect(withRecordPreparationLockWith(lockOf(log), { id: "host", surface: "sdk", grants: [] } as never, async () => "x")).rejects.toThrow("record-prepare-grant-required");
    await expect(withRecordPreparationLockWith(lockOf(log, false), principal, async () => "x")).rejects.toThrow("record-preparation-busy");
    expect(log).toEqual(["acquire"]);
    log.length = 0;
    const actorSeen = await withRecordPreparationLockWith(lockOf(log), principal, async (actor) => { log.push("action"); return actor; });
    expect([actorSeen, actorSeen === principal, log]).toEqual([principal, false, ["acquire", "action", "release"]]);
    await expect(withRecordPreparationLockWith(lockOf(log), principal, async () => { throw new Error("staging failed"); })).rejects.toThrow("staging failed");
    expect(log.slice(3)).toEqual(["acquire", "release"]);
  });

  it("L2 captures the actor before waiting: a principal edited during the acquire changes nothing", async () => {
    const principal = { id: "host", surface: "sdk", grants: ["operation-bundle.prepare"] };
    const editing: RecordPreparationLock = { acquire: async () => { principal.id = "other"; principal.grants.push("extra"); return true; }, release: async () => {} };
    const actor = await withRecordPreparationLockWith(editing, principal as never, async (seen) => seen);
    expect(actor).toEqual({ id: "host", surface: "sdk", grants: ["operation-bundle.prepare"] });
  });
});

describe("the root forms", () => {
  it("Z1 the bodies make no root-form call; the root form and the disk lock reach each incumbent with the root and their old arguments", async () => {
    const seed = await observed((root) => stagePageUpdateBundle(root, "concepts", "p", Buffer.from("a\n"), Buffer.from("b\n")));
    const spies = [vi.spyOn(capacity, "scanOperationInventory"), vi.spyOn(keyEpoch, "readOperationKey"), vi.spyOn(runStore, "readOperationRun"), vi.spyOn(shared, "readPageDigest")];
    const lockSpies = [vi.spyOn(lockGate, "acquireMutationLock").mockResolvedValue(true), vi.spyOn(lock, "releaseLock").mockResolvedValue(undefined)];
    await observeOperationBundleWith(memoryReads(seed, []), seed.staged.manifestDigest);
    await withRecordPreparationLockWith(lockOf([]), { id: "host", surface: "sdk", grants: ["operation-bundle.prepare"] } as never, async () => "x");
    expect([...spies, ...lockSpies].map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
    await observeOperationBundle(seed.root, seed.staged.manifestDigest);
    expect(spies.map((spy) => spy.mock.calls[0]?.[0])).toEqual([seed.root, seed.root, seed.root, seed.root]);
    expect([spies[2]!.mock.calls[0]?.[1], (spies[3]!.mock.calls[0]?.[1] as PageOperationMutation).target.slug]).toEqual([expect.objectContaining({ bundleId: seed.staged.bundleId }), "p"]);
    await withRecordPreparationLockWith(diskRecordPreparationLock(seed.root), { id: "host", surface: "sdk", grants: ["operation-bundle.prepare"] } as never, async () => "x");
    expect([lockSpies[0]!.mock.calls, lockSpies[1]!.mock.calls]).toEqual([[[seed.root, "ordinary"]], [[seed.root]]]);
  });
});
