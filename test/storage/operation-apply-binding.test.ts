/**
 * @file test/storage/operation-apply-binding.test.ts
 * @description The operation-bundle application ladder as ONE body over the
 * run stores (`approveAndApplyOperationBundleWith(OperationRunStores)`), the
 * session load it starts with (`loadRunSessionWith`, `loadApprovedActionWith`),
 * and the run-evidence writer (`writeRunEvidenceWith(RunEvidenceBlobs)`).
 *
 * HOW IT IS BUILT. A real signed bundle is staged on disk with the existing
 * fixtures and its manifest, key and run are copied into memory stores. Those
 * stores append through the run writer's OWN body (`appendOperationTransitionWith`
 * over memory run steps) and write evidence through the evidence body, and they
 * log every call. With the same fixed clock, authority and adapter doubles, the
 * body over memory must leave the SAME run (every transition, signature and
 * evidence reference) and return the same result as the root form leaves on disk.
 * Memory cases pin each refusal's reads, the cancellation arms, and the
 * write-ahead embedding marker. The last cases show that the body makes no
 * root-form store call, and that the root form reaches each with exact
 * arguments.
 *
 * NOT SHOWN HERE: the adapters, the authority resolver, the store mechanisms
 * and the run integrity itself; the executor, recovery and store suites show
 * those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as cancelRequest from "../../src/operation-bundles/cancel-request.js";
import * as evidenceStore from "../../src/operation-bundles/evidence-store.js";
import { approveAndApplyOperationBundleLocked, approveAndApplyOperationBundleWith } from "../../src/operation-bundles/executor.js";
import * as keyEpoch from "../../src/operation-bundles/key-epoch.js";
import * as manifestStore from "../../src/operation-bundles/manifest-store.js";
import * as runStore from "../../src/operation-bundles/run-store.js";
import * as pendingEmbeddings from "../../src/utils/pending-embeddings.js";
import {
  approveRequest, readStagedRun, stagePageUpdateBundle, stageSourceAndOptionalProjection, stageSourceBundle, WORKSPACE, type StagedBundle,
} from "../operation-bundles/executor-fixtures.js";
import { tempRootTracker } from "../temp-roots.js";
import { copiedProject, memoryRunStores, runtimeOf, type CopiedProject, type MemoryRunWorld } from "./operation-run-memory.js";

const tracker = tempRootTracker();
afterEach(async () => { vi.restoreAllMocks(); await tracker.cleanup(); });

const PAGE_FROM = Buffer.from("old page\n"), PAGE_TO = Buffer.from("new page\n");

/** Apply over memory, then through the root form on the same project: both results, both final runs, and the memory log. */
async function bothWays(stage: (root: string) => Promise<StagedBundle>) {
  const seed = await copiedProject(tracker, stage);
  const log: string[] = [];
  const stores = memoryRunStores(seed, log);
  const memory = await approveAndApplyOperationBundleWith(stores, approveRequest(seed.staged, runtimeOf([])));
  const disk = await approveAndApplyOperationBundleLocked(seed.root, approveRequest(seed.staged, runtimeOf([])));
  return { memory, disk, memoryRun: stores.current(), diskRun: await readStagedRun(seed.root, seed.staged), log };
}

describe("the application ladder: the body over memory answers as the root form does on disk", () => {
  it("A1 applies one source mutation to the same signed run, in the incumbent order of reads, appends and evidence", async () => {
    const { memory, disk, memoryRun, diskRun, log } = await bothWays((root) => stageSourceBundle(root));
    expect([memory, memoryRun]).toEqual([disk, diskRun]);
    expect(memory.state).toBe("succeeded");
    expect(log).toEqual(["manifest", "key", "run", "cancel?", "approved", "apply-started", "cancel?", "mutation-started",
      "evidence source-retain", "mutation-applied", "succeeded", "cancel removed"]);
  });

  it("A2 settles a failed optional projection with its warning, to the same run as the root form", async () => {
    const { memory, disk, memoryRun, diskRun, log } = await bothWays((root) => stageSourceAndOptionalProjection(root));
    expect([memory, memoryRun]).toEqual([disk, diskRun]);
    expect(memory.state).toBe("succeeded-with-warnings");
    expect(log.slice(log.indexOf("mutation-applied") + 1)).toEqual(["cancel?", "projection-started", "evidence projection", "projection-failed",
      "warning-recorded", "succeeded-with-warnings", "cancel removed"]);
  });
});

/** Apply over memory `world` with the copied project, `grants` as given: the result and the log. */
async function overMemory(seed: CopiedProject, world: MemoryRunWorld = {}, request = approveRequest(seed.staged, runtimeOf([]))) {
  const log: string[] = [];
  const result = await approveAndApplyOperationBundleWith(memoryRunStores(seed, log, world), request);
  return { result, log, codes: result.problems.map(({ code }) => code) };
}

describe("the session load and the cancellation arms over memory", () => {
  it("L1 stops at each load refusal with its own code, reading nothing after it", async () => {
    const seed = await copiedProject(tracker, (root) => stageSourceBundle(root));
    const cases: Array<[MemoryRunWorld, string, string[]]> = [
      [{ manifest: { status: "absent" } }, "review-item-not-found", ["manifest"]],
      [{ manifest: { status: "unavailable", detail: "x" } }, "review-store-unavailable", ["manifest"]],
      [{ key: { status: "absent" } }, "integrity-key-missing", ["manifest", "key"]],
      [{ key: { status: "unavailable" } }, "integrity-key-unreadable", ["manifest", "key"]],
      [{ run: { status: "absent" } }, "review-item-not-found", ["manifest", "key", "run"]],
      [{ run: { status: "unavailable", detail: "x", code: "integrity-mismatch" as never } }, "integrity-mismatch", ["manifest", "key", "run"]],
    ];
    for (const [world, code, reads] of cases) expect(await overMemory(seed, world)).toMatchObject({ codes: [code], log: reads });
    const wrongDigest = { ...approveRequest(seed.staged, runtimeOf([])), manifestDigest: `sha256:${"0".repeat(64)}` as never };
    expect(await overMemory(seed, {}, wrongDigest)).toMatchObject({ codes: ["review-digest-mismatch"], log: ["manifest"] });
    expect(await overMemory(seed, {}, approveRequest(seed.staged, runtimeOf([]), []))).toMatchObject({ codes: ["approval-grant-missing"], log: ["manifest", "key", "run"] });
  });

  it("C1 a pending request before apply cancels and removes it; an unreadable one is removed with no transition", async () => {
    const seed = await copiedProject(tracker, (root) => stageSourceBundle(root));
    const present = { status: "present", request: {} } as never;
    const cancelled = await overMemory(seed, { cancels: [present] });
    expect([cancelled.result.state, cancelled.log.slice(3)]).toEqual(["cancelled", ["cancel?", "cancelled", "cancel removed"]]);
    const unreadable = await overMemory(seed, { cancels: [{ status: "unavailable", detail: "x" }] });
    expect([unreadable.codes, unreadable.log.slice(3)]).toEqual([["review-store-unavailable"], ["cancel?", "cancel removed"]]);
  });

  it("C2 a request seen at a safe point parks the run before the mutation starts, then removes the request", async () => {
    const seed = await copiedProject(tracker, (root) => stageSourceBundle(root));
    const parked = await overMemory(seed, { cancels: [{ status: "absent" }, { status: "present", request: {} } as never] });
    expect([parked.result.state, parked.codes]).toEqual(["recovery-required", ["bundle-recovery-required"]]);
    expect(parked.log.slice(4)).toEqual(["approved", "apply-started", "cancel?", "recovery-required", "cancel removed"]);
  });
});

describe("the write-ahead embedding marker over memory", () => {
  const stagePage = (root: string) => stagePageUpdateBundle(root, "concepts", "p", PAGE_FROM, PAGE_TO);

  it("M1 merges the page into the marker BEFORE the effect and again before its outcome", async () => {
    const seed = await copiedProject(tracker, stagePage);
    const log: string[] = [];
    const result = await approveAndApplyOperationBundleWith(memoryRunStores(seed, log), approveRequest(seed.staged, runtimeOf(log)));
    expect(result.state).toBe("succeeded");
    expect(log.slice(log.indexOf("mutation-started") + 1, log.indexOf("mutation-applied") + 1)).toEqual([
      "marker?", "marker concepts/p", "page applied", "marker?", "marker concepts/p", "evidence page", "mutation-applied"]);
  });

  it("M2 an unreadable marker parks the run and the effect is never attempted", async () => {
    const seed = await copiedProject(tracker, stagePage);
    const log: string[] = [];
    const result = await approveAndApplyOperationBundleWith(memoryRunStores(seed, log, { marker: { status: "unavailable", entries: [] } }), approveRequest(seed.staged, runtimeOf(log)));
    expect([result.state, log.includes("page applied")]).toEqual(["recovery-required", false]);
    expect(log.slice(log.indexOf("mutation-started") + 1)).toEqual(["marker?", "evidence page", "mutation-failed", "recovery-required"]);
  });
});

describe("the run-evidence body", () => {
  const LOCATION = { workspaceId: WORKSPACE, runId: "oprun_x" as never, type: "source-retain", provenance: "apply" };

  it("E1 checks metadata, then derives the location, then decides: over the cap a reference with no write, else one blob", async () => {
    const log: string[] = [];
    const blobs: evidenceStore.RunEvidenceBlobs = { target: (_ws, runId) => { log.push(`target ${runId}`); return { writeBlob: async (digest, _b, max) => { log.push(`blob ${digest.length} ${max}`); } }; } };
    await expect(evidenceStore.writeRunEvidenceWith(blobs, { ...LOCATION, type: "" }, Buffer.from("x"))).rejects.toThrow("evidence type must be a bounded string");
    const refusing: evidenceStore.RunEvidenceBlobs = { target: () => { throw new Error("invalid run id"); } };
    await expect(evidenceStore.writeRunEvidenceWith(refusing, LOCATION, Buffer.alloc(300 * 1024))).rejects.toThrow("invalid run id");
    const over = await evidenceStore.writeRunEvidenceWith(blobs, LOCATION, Buffer.alloc(300 * 1024, 0x41));
    expect([over, log]).toEqual([expect.objectContaining({ kind: "evidence-over-limit", byteCount: 300 * 1024 }), ["target oprun_x"]]);
    const stored = await evidenceStore.writeRunEvidenceWith(blobs, LOCATION, Buffer.from("x"));
    expect([stored, log.slice(1)]).toEqual([expect.objectContaining({ byteCount: 1, type: "source-retain", provenance: "apply" }), ["target oprun_x", "blob 64 262144"]]);
  });
});

describe("the root form", () => {
  /** Pass-through spies on every root-form store the run domain reaches. */
  const storeSpies = () => [
    vi.spyOn(manifestStore, "readOperationManifest"), vi.spyOn(keyEpoch, "readOperationKey"), vi.spyOn(runStore, "readOperationRun"),
    vi.spyOn(runStore, "appendOperationTransitionLocked"), vi.spyOn(evidenceStore, "writeRunEvidenceCreateOnly"),
    vi.spyOn(cancelRequest, "readCancelRequest"), vi.spyOn(cancelRequest, "removeCancelRequestLocked"),
    vi.spyOn(pendingEmbeddings, "readPendingMarker"), vi.spyOn(pendingEmbeddings, "writePendingEmbeddingsStrict"),
  ];

  it("Z1 the body makes no root-form store call; the root form reaches each with the root and its old arguments", async () => {
    const seed = await copiedProject(tracker, (root) => stageSourceBundle(root));
    const spies = storeSpies();
    await approveAndApplyOperationBundleWith(memoryRunStores(seed, []), approveRequest(seed.staged, runtimeOf([])));
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    await approveAndApplyOperationBundleLocked(seed.root, approveRequest(seed.staged, runtimeOf([])));
    const [manifest, key, run, append, evidence, cancel, remove] = spies;
    const runId = seed.run.runId;
    expect([manifest!.mock.calls[0], key!.mock.calls[0], run!.mock.calls[0]?.[0]]).toEqual([[seed.root, WORKSPACE, seed.staged.bundleId], [seed.root], seed.root]);
    expect([append!.mock.calls.map((call: readonly unknown[]) => call[0]), evidence!.mock.calls[0]?.slice(0, 2)]).toEqual([Array(5).fill(seed.root),
      [seed.root, { workspaceId: WORKSPACE, runId, type: "source-retain", provenance: "apply" }]]);
    expect([cancel!.mock.calls, remove!.mock.calls]).toEqual([[[seed.root, WORKSPACE, runId], [seed.root, WORKSPACE, runId]], [[seed.root, WORKSPACE, runId]]]);
  });
});
