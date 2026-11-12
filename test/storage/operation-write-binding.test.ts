/**
 * @file test/storage/operation-write-binding.test.ts
 * @description The operation-bundle WRITERS as root-free bodies over memory
 * collaborators: the run writers (`…With(OperationRunWriteSteps)`), the
 * create-only manifest writer (`writeOperationManifestCreateOnlyWith`) and staging
 * (`stageOperationBundleWith(OperationStageSteps)`).
 *
 * HOW IT IS BUILT. A real signed project is staged once with the existing
 * fixtures; the memory steps answer with ITS key, run and manifest and log every
 * call. They prove each body's order and fail-closed refusals (no write after a
 * failed check), not confinement, durability or the create-only publication,
 * which stay in the local-disk factories and are covered by the real-disk journey
 * (`operation-write-journey.test.ts`) and the existing store suites. The last
 * case spies on the physical writers and readers to show the bound bodies make
 * no ambient call, while the shipped root entry reaches them with exact arguments.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as atomicWriteModule from "../../src/utils/atomic-write.js";
import * as confinedRead from "../../src/utils/confined-read.js";
import * as runStoreIo from "../../src/utils/run-store-io.js";
import * as durableLeaf from "../../src/operation-bundles/durable-leaf.js";
import { scanOperationInventory, type OperationInventory } from "../../src/operation-bundles/capacity.js";
import { readOperationKey, type OperationKeyRead } from "../../src/operation-bundles/key-epoch.js";
import { readOperationManifest, writeOperationManifestCreateOnlyWith, type OperationManifestWriteSteps } from "../../src/operation-bundles/manifest-store.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import { operationRunBinding, operationRunPredecessor, verifyOperationRunIntegrity } from "../../src/operation-bundles/run-integrity.js";
import { parseOperationRun } from "../../src/operation-bundles/run-parse.js";
import {
  appendOperationTransitionWith, appendRecoveredTransitionWith, createOperationRunWith, type OperationRunWriteSteps,
} from "../../src/operation-bundles/run-store.js";
import type { OperationRun, OperationRunBinding } from "../../src/operation-bundles/run-types.js";
import { stageOperationBundleWith, type OperationStageSteps, type StageOperationBundleRequest } from "../../src/operation-bundles/stage.js";
import type { OperationBundleManifest, OperationDigest } from "../../src/operation-bundles/types.js";
import { tempRootTracker } from "../temp-roots.js";
import { readStagedRun, stageSourceBundle, WORKSPACE } from "../operation-bundles/executor-fixtures.js";

const PREFIX = "operation-write-binding-";
const ACTOR = { id: "operator", surface: "cli" as const, grants: [] };
/** The fixture genesis actor (`executor-fixtures.ts`) and its default source bytes. */
const PLANNER = { id: "planner", surface: "sdk" as const, grants: [] };
const SOURCE = Buffer.from("retained source\n");
const SOURCE_DIGEST = createHash("sha256").update(SOURCE).digest("hex");
const AT = "2026-07-19T00:30:00.000Z";
const tracker = tempRootTracker();
let emptyInventory: OperationInventory;
let root = "", key: Extract<OperationKeyRead, { status: "ok" }>, run: OperationRun, binding: OperationRunBinding, manifest: OperationBundleManifest;
beforeAll(async () => {
  root = await tracker.create(PREFIX);
  const staged = await stageSourceBundle(root);
  run = await readStagedRun(root, staged);
  binding = operationRunBinding(run);
  const keyRead = await readOperationKey(root), manifestRead = await readOperationManifest(root, WORKSPACE, staged.bundleId);
  if (keyRead.status !== "ok" || manifestRead.status !== "ok") throw new Error("fixture unreadable");
  key = keyRead; manifest = manifestRead.manifest;
  emptyInventory = await scanOperationInventory(await tracker.create(PREFIX)); // a real empty inventory, snapshotted
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => tracker.cleanup());

/** Memory run steps over the real key and run; every call logged, every replacement kept. */
function runSteps(log: string[], written: string[], over: Partial<OperationRunWriteSteps> = {}): OperationRunWriteSteps {
  return {
    readRun: async () => { log.push("readRun"); return { status: "ok", run }; },
    readKey: async () => { log.push("readKey"); return key; },
    readEvidenceLeaf: async () => { log.push("readEvidence"); return { kind: "absent" }; },
    publishGenesis: async (_binding, serialized) => { log.push("publishGenesis"); written.push(serialized); },
    replaceRun: async (_binding, serialized) => { log.push("replaceRun"); written.push(serialized); },
    ...over,
  };
}

const APPROVE = { type: "approved" as const, stateAfter: "approved" as const, payload: { kind: "authority" as const, authoritySnapshotDigest: `sha256:${"9".repeat(64)}` as OperationDigest }, actor: ACTOR, at: AT };

describe("the run writers over memory steps", () => {
  it("B1 appends after the predecessor read and a FRESH key, writing exactly one authenticated next state", async () => {
    const log: string[] = [], written: string[] = [];
    const next = await appendOperationTransitionWith(runSteps(log, written), binding, operationRunPredecessor(run), APPROVE);
    expect(log).toEqual(["readRun", "readKey", "replaceRun"]);
    const parsed = parseOperationRun(written[0]!, binding);
    expect([parsed.stateVersion, parsed.state, verifyOperationRunIntegrity(parsed, key.key, binding), next]).toEqual([run.stateVersion + 1, "approved", true, parsed]);
  });

  it("B2 refuses a stale predecessor before the key, and a changed key epoch before any write", async () => {
    const stale: string[] = [], changed: string[] = [];
    const before = { ...operationRunPredecessor(run), stateVersion: run.stateVersion + 1 };
    await expect(appendOperationTransitionWith(runSteps(stale, []), binding, before, APPROVE)).rejects.toThrow("predecessor changed");
    const otherEpoch = { ...key, keyEpochId: `sha256:${"1".repeat(64)}` as OperationDigest };
    await expect(appendOperationTransitionWith(runSteps(changed, [], { readKey: async () => { changed.push("readKey"); return otherEpoch; } }), binding, operationRunPredecessor(run), APPROVE))
      .rejects.toThrow("key epoch changed");
    expect([stale, changed]).toEqual([["readRun"], ["readRun", "readKey"]]);
  });

  it("B3 publishes genesis create-only, reading the run back ONLY when publication reports a collision", async () => {
    const input = { manifest, manifestDigest: binding.manifestDigest, keyEpochId: key.keyEpochId, actor: PLANNER, at: manifest.createdAt, declaredCompensatorMutationIds: [], controlTransitionAllowance: 32 };
    const log: string[] = [], written: string[] = [];
    await createOperationRunWith(runSteps(log, written), input);
    const collided: string[] = [];
    const colliding = runSteps(collided, [], { publishGenesis: async (_b, _s, message) => { collided.push("publishGenesis"); throw new Error(await message()); } });
    await expect(createOperationRunWith(colliding, input)).rejects.toThrow("operation run genesis already exists: ok");
    expect([log, collided]).toEqual([["readKey", "publishGenesis"], ["readKey", "publishGenesis", "readRun"]]);
    expect(verifyOperationRunIntegrity(parseOperationRun(written[0]!, binding), key.key, binding)).toBe(true);
  });

  it("B4 checks the recovered proof before ANY read or write", async () => {
    const log: string[] = [];
    const sameBundle = { actor: ACTOR, at: AT, recoveryBinding: binding, recoveryExpected: operationRunPredecessor(run), recoveryManifest: manifest };
    await expect(appendRecoveredTransitionWith(runSteps(log, []), binding, operationRunPredecessor(run), sameBundle)).rejects.toThrow("does not settle");
    expect(log).toEqual([]);
  });
});

describe("the manifest writer and staging over memory steps", () => {
  it("B5 reads a manifest back only after a reported create collision, and refuses a non-identical one", async () => {
    const steps = (outcome: "created" | "collision", log: string[], found = true): OperationManifestWriteSteps => ({
      createManifestLeaf: async () => { log.push("create"); return outcome; },
      readManifest: async () => { log.push("readManifest"); return found ? { status: "ok", manifest } : { status: "absent" }; },
    });
    const created: string[] = [], replay: string[] = [], conflict: string[] = [];
    expect(await writeOperationManifestCreateOnlyWith(steps("created", created), manifest)).toBe("created");
    expect(await writeOperationManifestCreateOnlyWith(steps("collision", replay), manifest)).toBe("same");
    await expect(writeOperationManifestCreateOnlyWith(steps("collision", conflict, false), manifest)).rejects.toThrow("operation manifest conflict: absent");
    expect([created, replay, conflict]).toEqual([["create"], ["create", "readManifest"], ["create", "readManifest"]]);
  });

  it("B6 stages through every preflight before the first write, then payloads, manifest and genesis in order; a dry run writes nothing", async () => {
    const pass = async (dryRun: boolean) => {
      const log: string[] = [];
      await stageOperationBundleWith(memoryStage(log), { ...stageRequest(), dryRun });
      return log;
    };
    const preflight = ["scanInventory", "readKey", "inspectMaterialization", "assertReviewIdentity"];
    expect(await pass(true)).toEqual(preflight);
    expect(await pass(false)).toEqual([...preflight, "writePayload", "writeManifest", "readRun", "createRun"]);
  });

  it("B7 makes no ambient physical call from the bound bodies, while the root entry reaches the publication with exact arguments", async () => {
    const spies = [vi.spyOn(atomicWriteModule, "atomicWrite"), vi.spyOn(atomicWriteModule, "atomicWriteNoReplaceDurable"),
      vi.spyOn(runStoreIo, "publishRunGenesis"), vi.spyOn(durableLeaf, "readDurableOperationLeafBuffer"), vi.spyOn(confinedRead, "readConfinedLeafBuffer")];
    await appendOperationTransitionWith(runSteps([], []), binding, operationRunPredecessor(run), APPROVE);
    await stageOperationBundleWith(memoryStage([]), stageRequest());
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0]);
    const fresh = await tracker.create(PREFIX);
    const staged = await stageSourceBundle(fresh);
    const runId = (await readStagedRun(fresh, staged)).runId, paths = operationPaths(fresh, WORKSPACE);
    expect(spies[2]!.mock.calls.map((call) => call[0])).toEqual([{ root: fresh, file: paths.runFile(runId) }]);
    expect(spies[1]!.mock.calls.filter((call) => call[0] === paths.manifestFile(staged.bundleId)).map((call) => call[2]))
      .toEqual([{ confineRoot: fresh, exactParent: true, mode: 0o600 }]);
    expect(path.dirname(paths.manifestFile(staged.bundleId))).toBe(paths.bundleRoot(staged.bundleId));
  });
});

/** Re-stage the fixture bundle's own manifest content as a request. */
function stageRequest(): StageOperationBundleRequest {
  const { schemaVersion: _v, bundleId, runId, createdAt, mutations, ...intent } = manifest;
  return {
    draft: { ...intent, mutations: mutations.map(({ index: _i, mutationId: _m, ...rest }) => rest), run: { actor: PLANNER, declaredCompensatorIndexes: [], controlTransitionAllowance: 32 } },
    payloads: new Map([[SOURCE_DIGEST, SOURCE]]), clock: { now: () => new Date(createdAt) }, idsForTest: { bundleId, runId },
  } as unknown as StageOperationBundleRequest;
}

/** Memory staging steps: an empty healthy inventory, the real key, nothing yet materialized. */
function memoryStage(log: string[]): OperationStageSteps {
  const step = <T>(name: string, value: T) => async () => { log.push(name); return value; };
  return {
    scanInventory: step("scanInventory", emptyInventory), readKey: step("readKey", key as OperationKeyRead),
    inspectMaterialization: step("inspectMaterialization", { complete: false, missingManifest: true, missingRun: true, missingPayloads: new Set([SOURCE_DIGEST]), physicalActiveByteDelta: 0, settled: false }),
    assertReviewIdentityAvailable: step("assertReviewIdentity", undefined), createKeyForEmptyEpoch: step("createKey", key),
    writePayload: step("writePayload", "created"), writeManifest: step("writeManifest", "created"),
    readRun: step("readRun", { status: "absent" as const }), createRun: step("createRun", run),
  };
}
