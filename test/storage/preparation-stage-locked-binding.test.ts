/**
 * @file test/storage/preparation-stage-locked-binding.test.ts
 * @description Locked staging as ONE body over steps that take no project root:
 * `stagePreparationLockedWith` over `StageLockedSteps`. This file uses it, which
 * exists only after staging was given its steps, so it has NO before-edit run.
 *
 * HOW IT IS BUILT. One real empty project is scanned on disk, once, for a real
 * inventory; then memory steps answer every read and log every call, so the
 * parent park, the dry-run parks and answers, the full create, the complete
 * replay and the input park are pinned in order, and a dry run is shown to
 * reach no mint, publication or write. The composition is shown reaching each
 * store's own body, and the root form the incumbent readers with exact arguments.
 *
 * NOT SHOWN HERE: the key mint, the capacity arithmetic, the supersession graph
 * and the writers themselves; the stage, capacity, key-epoch and store suites
 * show those.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as capacity from "../../src/preparations/capacity.js";
import * as evidenceStore from "../../src/preparations/evidence-store.js";
import { mintPreparationId, mintPreparationRunId } from "../../src/preparations/ids.js";
import * as keyEpoch from "../../src/preparations/key-epoch.js";
import * as manifestStore from "../../src/preparations/manifest-store.js";
import * as runStore from "../../src/preparations/run-store.js";
import {
  stagePreparationLocked, stagePreparationLockedWith, stageLockedStepsOver,
  type StageLockedSteps, type StagePreparationRequest,
} from "../../src/preparations/stage.js";
import * as workflowParent from "../../src/preparations/workflow-parent.js";
import { tempRootTracker } from "../temp-roots.js";
import { fixturePlan, seedInput } from "../preparations/store-fixture.js";

const tracker = tempRootTracker();
afterAll(() => tracker.cleanup());
afterEach(() => { vi.restoreAllMocks(); });

const EPOCH = `sha256:${"e".repeat(64)}`;
const KEY = { status: "ok", key: Buffer.alloc(32), keyEpochId: EPOCH } as unknown as keyEpoch.PreparationKeyRead;
const ACTOR = { id: "operator", surface: "cli" } as const;
const IDS = { preparationId: mintPreparationId(), runId: mintPreparationRunId() };
let INVENTORY: capacity.PreparationInventory;
/** The same inventory, as a scan that saw the fixed ids' preparation directory and run leaf would report it. */
let SEEN: capacity.PreparationInventory;

beforeAll(async () => {
  INVENTORY = await capacity.scanPreparationInventory(await tracker.create("stage-locked-binding-"));
  SEEN = { ...INVENTORY, preparationIds: new Set([IDS.preparationId]), runIds: new Set([IDS.runId]) };
});

/** A staging request over the fixture plan and seed, with fixed ids and clock. */
const requestOf = (overrides: Partial<StagePreparationRequest> = {}): StagePreparationRequest => ({
  plan: fixturePlan(), createdBy: ACTOR, actor: ACTOR, initialInputs: [seedInput()], controlTransitionAllowance: 16,
  clock: { now: () => new Date("2026-10-14T00:00:00.000Z") }, idsForTest: IDS, ...overrides,
});

/**
 * What the memory steps answer; anything left out is absent or healthy. `seen`
 * makes the scan report the fixed ids, so the body reads each leg; `present`
 * also answers those reads as present, and implies `seen`.
 */
interface World { parent?: unknown; key?: unknown; seen?: boolean; present?: boolean; manifest?: unknown; materialized?: unknown }

/** Memory steps over `world`, each call logged. */
function stepsOf(log: string[], world: World = {}): StageLockedSteps {
  const present = world.present === true;
  return {
    verifyParent: async () => { log.push("parent"); return world.parent as never; },
    scanInventory: async () => { log.push("scan"); return present || world.seen === true ? SEEN : INVENTORY; },
    readKey: async () => { log.push("key"); return (world.key ?? KEY) as never; },
    mintEmptyEpochKey: async () => { log.push("mint"); return { keyEpochId: EPOCH as never, publish: async () => { log.push("publish-key"); } }; },
    readEvidence: async () => { log.push("evidence"); return present ? { status: "ok", byteCount: 1 } : { status: "absent" }; },
    readManifest: async () => { log.push("manifest"); return (present ? world.manifest : { status: "absent" }) as never; },
    readRun: async () => { log.push("run"); return (present ? { status: "ok" } : { status: "absent" }) as never; },
    materializeInputs: async () => { log.push("materialize"); return (world.materialized ?? { status: "materialized" }) as never; },
    writeManifest: async () => { log.push("write-manifest"); },
    createRun: async () => { log.push("create-run"); },
  };
}

/** Stage `request` over `world`: the status (and reason or wrote flag) and the log. */
async function stage(request: StagePreparationRequest, world: World = {}): Promise<[unknown, string[]]> {
  const log: string[] = [];
  const result = await stagePreparationLockedWith(stepsOf(log, world), request);
  return [result.status === "parked" ? result.reason : `staged wrote=${String(result.wrote)}`, log];
}

const READS = ["scan", "key", "evidence", "manifest", "run"];
/** A scan that saw neither the preparation nor its run already answers every leg absent: no leg is read. */
const SCAN_ONLY = ["scan", "key"];

describe("locked staging over its steps", () => {
  it("L1 a first stage with no key mints, reads, then publishes the key, the inputs, the manifest and the run, in order", async () => {
    expect(await stage(requestOf(), { key: { status: "absent" } })).toEqual(["staged wrote=true",
      ["scan", "key", "mint", "publish-key", "materialize", "write-manifest", "create-run"]]);
    expect(await stage(requestOf(), { key: { status: "absent" }, seen: true })).toEqual(["staged wrote=true",
      ["scan", "key", "mint", "evidence", "manifest", "run", "publish-key", "materialize", "write-manifest", "create-run"]]);
  });

  it("L2 a dry run parks before any mint when there is no key, and with a key reads but writes nothing", async () => {
    expect(await stage(requestOf({ dryRun: true }), { key: { status: "absent" } })).toEqual(["preparation-integrity-key-missing", ["scan", "key"]]);
    expect(await stage(requestOf({ dryRun: true }))).toEqual(["staged wrote=false", SCAN_ONLY]);
    expect(await stage(requestOf({ dryRun: true }), { seen: true })).toEqual(["staged wrote=false", READS]);
  });

  it("L3 a complete replay of the same manifest writes nothing", async () => {
    const dry = await stagePreparationLockedWith(stepsOf([]), requestOf({ dryRun: true }));
    if (dry.status !== "staged") throw new Error("the dry run did not stage");
    expect(await stage(requestOf(), { present: true, manifest: { status: "ok", manifest: dry.manifest } })).toEqual(["staged wrote=false", READS]);
  });

  it("L4 an unverified workflow parent parks first; an input that cannot materialize parks after the key is published, with no manifest", async () => {
    const parent = { workflowRunId: "build-1", workflowId: "build", workflowDigest: EPOCH, stageId: "draft" };
    expect(await stage(requestOf({ plan: { ...fixturePlan(), workflowParent: parent } as never }), { parent: { status: "absent" } }))
      .toEqual(["workflow-parent-absent", ["parent"]]);
    expect(await stage(requestOf(), { key: { status: "absent" }, materialized: { status: "unavailable", code: "changed-digest" } }))
      .toEqual(["initial-input-changed-digest", ["scan", "key", "mint", "publish-key", "materialize"]]);
  });
});

describe("the composition and the root form", () => {
  it("B1 the composition reaches each store's own body over its own seam, and carries the caller's mint and writes", async () => {
    const seams = { parents: { tag: "parents" }, lifecycle: { tag: "lifecycle" }, keys: { tag: "keys" }, evidence: { tag: "evidence" },
      manifests: { tag: "manifests" }, runs: { tag: "runs" } } as never as Record<string, never>;
    const spies = [
      vi.spyOn(workflowParent, "verifyWorkflowParentFrom"), vi.spyOn(capacity, "scanPreparationInventoryBorrowingFrom"),
      vi.spyOn(keyEpoch, "readPreparationKeyFrom"), vi.spyOn(evidenceStore, "readPreparationEvidenceFrom"),
      vi.spyOn(manifestStore, "readPreparationManifestFrom"), vi.spyOn(runStore, "readPreparationRunFrom"),
    ].map((spy) => spy.mockResolvedValue({} as never));
    const writes = { mintEmptyEpochKey: vi.fn(), materializeInputs: vi.fn(), writeManifest: vi.fn(), createRun: vi.fn() };
    const steps = stageLockedStepsOver(seams as never, writes);
    await Promise.all([steps.verifyParent({} as never), steps.scanInventory(), steps.readKey(), steps.readEvidence({} as never, "d"),
      steps.readManifest("ws", "p" as never), steps.readRun({} as never)]);
    expect(spies.map((spy) => spy.mock.calls[0]?.[0])).toEqual([seams.parents, seams.lifecycle, seams.keys, seams.evidence, seams.manifests, seams.runs]);
    expect([steps.mintEmptyEpochKey, steps.materializeInputs, steps.writeManifest, steps.createRun]).toEqual([writes.mintEmptyEpochKey, writes.materializeInputs, writes.writeManifest, writes.createRun]);
  });

  it("B2 the root form reaches the incumbent readers with its root, and a dry run reaches no mint", async () => {
    const scan = vi.spyOn(capacity, "scanPreparationInventory").mockResolvedValue(SEEN);
    const key = vi.spyOn(keyEpoch, "readPreparationKey").mockResolvedValue(KEY);
    const mint = vi.spyOn(keyEpoch, "prepareKeyForEmptyEpochLocked");
    const evidence = vi.spyOn(evidenceStore, "readPreparationEvidence").mockResolvedValue({ status: "absent" });
    const manifest = vi.spyOn(manifestStore, "readPreparationManifest").mockResolvedValue({ status: "absent" });
    const run = vi.spyOn(runStore, "readPreparationRun").mockResolvedValue({ status: "absent" } as never);
    expect((await stagePreparationLocked("/project", requestOf({ dryRun: true }))).status).toBe("staged");
    expect([scan.mock.calls.map((call) => call.slice(0, 2)), key.mock.calls, mint.mock.calls, evidence.mock.calls[0]?.[0], manifest.mock.calls[0]?.slice(0, 2), run.mock.calls[0]?.[0]])
      .toEqual([[["/project", undefined]], [["/project"]], [], "/project", ["/project", fixturePlan().workspaceId], "/project"]);
  });
});
