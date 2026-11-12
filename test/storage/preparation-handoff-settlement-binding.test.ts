/**
 * @file test/storage/preparation-handoff-settlement-binding.test.ts
 * @description The gate's preparation handoff-settlement pass as ONE body,
 * `settlePreparationHandoffsWith(HandoffSettlementSteps)`, with the production
 * entry `settlePreparationHandoffsLocked(root)` delegating over the local-disk
 * binding `localHandoffSettlementSteps(root)`.
 *
 * HOW IT IS BUILT. Real preparations are staged with the existing fixtures
 * (`attempt-fixture.ts`, `cancel-settlement-fixture.ts`): three workspaces for the
 * pass's ordering, and real runs driven through an attempt to the durable
 * `cancelling` half of a crash-interrupted cancellation for the disk cases, which
 * settle them through the incumbent per-run settlement under the real project lock.
 *
 * WHAT IS MEMORY ONLY. The memory cases hand the body scripted steps answering with
 * the real inventory manifests and key epoch; they prove the body's skips, order,
 * single timestamp, fault isolation and rejections, NOT the per-run settlement,
 * which on disk stays one whole collaborator and is covered by the disk cases here
 * and the existing recovery suites.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as cancelSettlement from "../../src/preparations/attempts/cancel-settlement.js";
import { recordDurableCancellingLocked } from "../../src/preparations/attempts/cancel-settlement.js";
import { executePhaseAttempt } from "../../src/preparations/attempts/execute.js";
import * as capacity from "../../src/preparations/capacity.js";
import { scanPreparationInventory } from "../../src/preparations/capacity.js";
import * as cancellation from "../../src/preparations/cancellation.js";
import { preparationCancellationRequested } from "../../src/preparations/cancellation.js";
import * as keyEpoch from "../../src/preparations/key-epoch.js";
import { readPreparationKey } from "../../src/preparations/key-epoch.js";
import { preparationManifestDigest, type PreparationManifestV1 } from "../../src/preparations/manifest-parse.js";
import {
  localHandoffSettlementSteps, settlePreparationHandoffsLocked, settlePreparationHandoffsWith, type HandoffSettlementSteps,
} from "../../src/preparations/recovery.js";
import * as runStore from "../../src/preparations/run-store.js";
import type { PreparationRunRead } from "../../src/preparations/run-store.js";
import type { PreparationRunV1 } from "../../src/preparations/run-types.js";
import type { Sha256Digest } from "../../src/preparations/types.js";
import { attemptRequest, stagePreparationIn, type StagedPreparation } from "../preparations/attempt-fixture.js";
import { readRun, requestCancel, settlementInput, underLock } from "../preparations/cancel-settlement-fixture.js";
import { fixturePlan } from "../preparations/store-fixture.js";

const WORKSPACES = ["aone", "btwo", "cthree"] as const;
const roots: string[] = [];
let manifests: PreparationManifestV1[] = [];
let keyEpochId: Sha256Digest;
let runOf: PreparationRunV1;

/** A fresh temporary project root, removed after the file. */
async function freshRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "prep-handoff-settlement-"));
  roots.push(root);
  return root;
}

/** Stage one preparation into one workspace of an existing root. */
function stageIn(root: string, workspaceId: string): Promise<StagedPreparation> {
  return stagePreparationIn(root, fixturePlan((plan) => { plan.workspaceId = workspaceId; }));
}

/** A real run driven through one attempt and left at the durable `cancelling` half, its advisory present. */
async function cancellingRun(): Promise<StagedPreparation> {
  const staged = await stageIn(await freshRoot(), "research");
  await executePhaseAttempt(attemptRequest(staged));
  await requestCancel(staged);
  await underLock(staged.root, () => recordDurableCancellingLocked(settlementInput(staged)));
  return staged;
}

beforeAll(async () => {
  const root = await freshRoot();
  for (const workspaceId of WORKSPACES) await stageIn(root, workspaceId);
  manifests = [...(await scanPreparationInventory(root)).manifests];
  const key = await readPreparationKey(root);
  if (key.status !== "ok" || manifests.length !== WORKSPACES.length) throw new Error("fixture project unreadable");
  keyEpochId = key.keyEpochId;
  const read = await runStore.readPreparationRun(root, {
    runId: manifests[0]!.runId, preparationId: manifests[0]!.preparationId, workspaceId: manifests[0]!.workspaceId,
    manifestDigest: preparationManifestDigest(manifests[0]!), keyEpochId,
  });
  if (read.status !== "ok") throw new Error("fixture run unreadable");
  runOf = read.run;
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });

interface Script {
  problems?: number;
  manifests?: PreparationManifestV1[];
  key?: Awaited<ReturnType<HandoffSettlementSteps["readKeyEpoch"]>> | Error;
  run?: (workspaceId: string) => PreparationRunRead | Error;
  settle?: (workspaceId: string) => Error | undefined;
  scan?: Error;
}

/** Scripted steps over the real manifests and key epoch; every call logged in order, every settle's `at` kept. */
function memorySteps(script: Script, log: string[], ats: string[] = []): HandoffSettlementSteps {
  const answer = <T>(value: T | Error): T => { if (value instanceof Error) throw value; return value; };
  return {
    scanInventory: async () => { log.push("scan"); answer(script.scan ?? 0); return { problems: Array.from({ length: script.problems ?? 0 }, () => ({ dimension: "x", detail: "y" })), manifests: script.manifests ?? manifests }; },
    readKeyEpoch: async () => { log.push("key"); return answer(script.key ?? { status: "ok" as const, keyEpochId }); },
    readRun: async (binding) => { log.push(`run ${binding.workspaceId}`); return answer(script.run?.(binding.workspaceId) ?? { status: "ok" as const, run: runOf }); },
    settleRun: async (binding, _run, at) => { log.push(`settle ${binding.workspaceId}`); ats.push(at); answer(script.settle?.(binding.workspaceId) ?? 0); },
  };
}

describe("the handoff-settlement pass: one body over its own steps (memory)", () => {
  it("H1 skips before any run read when the inventory has a problem or no manifest, and before any run read when the key is not ok", async () => {
    const pass = async (script: Script) => { const log: string[] = []; await settlePreparationHandoffsWith(memorySteps(script, log)); return log; };
    expect(await pass({ problems: 1 })).toEqual(["scan"]);
    expect(await pass({ manifests: [] })).toEqual(["scan"]);
    expect(await pass({ key: { status: "absent" } })).toEqual(["scan", "key"]);
    expect(await pass({ key: { status: "unavailable" } })).toEqual(["scan", "key"]);
  });

  it("H2 reads every run before settling any, settles only ok runs in inventory order, with exact bindings and ONE timestamp", async () => {
    const log: string[] = [], ats: string[] = [], bindings: unknown[] = [];
    const steps = memorySteps({ run: (ws) => (ws === manifests[1]!.workspaceId ? { status: "absent" } : { status: "ok", run: runOf }) }, log, ats);
    const settleRun = steps.settleRun;
    steps.settleRun = (binding, run, at) => { bindings.push(binding); return settleRun(binding, run, at); };
    await settlePreparationHandoffsWith(steps);
    const [a, b, c] = manifests.map((manifest) => manifest.workspaceId);
    expect(log).toEqual(["scan", "key", `run ${a}`, `run ${b}`, `run ${c}`, `settle ${a}`, `settle ${c}`]);
    expect(bindings).toEqual([manifests[0]!, manifests[2]!].map((manifest) => ({
      runId: manifest.runId, preparationId: manifest.preparationId, workspaceId: manifest.workspaceId,
      manifestDigest: preparationManifestDigest(manifest), keyEpochId,
    })));
    expect([ats.length, new Set(ats).size, new Date(ats[0]!).toISOString()]).toEqual([2, 1, ats[0]]);
  });

  it("H3 isolates one run's settlement failure, but a fault in the inventory, key or run reads still rejects before any settlement", async () => {
    const log: string[] = [];
    const [a, , c] = manifests.map((manifest) => manifest.workspaceId);
    await expect(settlePreparationHandoffsWith(memorySteps({ settle: (ws) => (ws === a ? new Error("append failed") : undefined) }, log))).resolves.toBeUndefined();
    expect(log.filter((entry) => entry.startsWith("settle"))).toEqual(manifests.map((manifest) => `settle ${manifest.workspaceId}`));
    expect(log.at(-1)).toBe(`settle ${c}`);
    const runFault: string[] = [];
    await expect(settlePreparationHandoffsWith(memorySteps({ run: (ws) => (ws === c ? new Error("run read failed") : { status: "ok", run: runOf }) }, runFault))).rejects.toThrow("run read failed");
    expect(runFault.some((entry) => entry.startsWith("settle"))).toBe(false);
    await expect(settlePreparationHandoffsWith(memorySteps({ scan: new Error("scan failed") }, []))).rejects.toThrow("scan failed");
    await expect(settlePreparationHandoffsWith(memorySteps({ key: new Error("key failed") }, []))).rejects.toThrow("key failed");
  });
});

describe("the production entry and the local-disk binding (real disk)", () => {
  it("H4 settles a crash-interrupted cancellation the same way through the production entry and through the body over the local binding", async () => {
    const viaEntry = await cancellingRun(), viaBinding = await cancellingRun();
    expect([(await readRun(viaEntry)).state, (await readRun(viaBinding)).state]).toEqual(["cancelling", "cancelling"]);
    await underLock(viaEntry.root, () => settlePreparationHandoffsLocked(viaEntry.root));
    await underLock(viaBinding.root, () => settlePreparationHandoffsWith(localHandoffSettlementSteps(viaBinding.root)));
    const outcome = async (staged: StagedPreparation) => [(await readRun(staged)).state,
      await preparationCancellationRequested(staged.root, staged.binding.workspaceId, staged.binding.runId)];
    expect([await outcome(viaEntry), await outcome(viaBinding)]).toEqual([["cancelled", false], ["cancelled", false]]);
  });

  it("H5 makes no ambient read or write from the body over memory steps, while the production entry reaches every incumbent", async () => {
    const staged = await cancellingRun();
    const spies = [
      vi.spyOn(capacity, "scanPreparationInventory"), vi.spyOn(keyEpoch, "readPreparationKey"), vi.spyOn(runStore, "readPreparationRun"),
      vi.spyOn(cancelSettlement, "settleCancelledRunLocked"), vi.spyOn(cancellation, "removePreparationCancelLocked"),
    ];
    await settlePreparationHandoffsWith(memorySteps({}, []));
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual(spies.map(() => 0));
    await underLock(staged.root, () => settlePreparationHandoffsLocked(staged.root));
    expect(spies.map((spy) => spy.mock.calls.length > 0)).toEqual(spies.map(() => true));
    expect((await readRun(staged)).state).toBe("cancelled");
  });
});
