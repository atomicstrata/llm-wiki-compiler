/**
 * @file test/storage/viewer-projection-binding.test.ts
 * @description The run projection and the stage-output route as ONE body each
 * over their reads, `buildWorkflowRunProjectionWith` and
 * `gatherServableOutputWith`, bound through `runProjectionReadsOver` and
 * `stageOutputReadsOver`, with no project directory. This file uses them, which
 * exist only after each was given reads of its own, so it has NO before-edit run.
 *
 * HOW IT IS BUILT. One real run is started on disk, ONCE: its authenticated run,
 * its loaded profile and the root projection are taken, then the directory is
 * removed before any case runs. Memory reads answer from those values and log
 * every call, so the projection is required to equal the disk's (all but the
 * clock), and the refusal ladders, the drift retry and fallback, the live host's
 * anchor and budget, and the order of reads are pinned. The bound compositions
 * are shown calling their lower one bodies; the root forms reaching the
 * incumbent root readers and the live provider with exact arguments.
 *
 * NOT SHOWN HERE: the live provider's own verification and timeouts (the viewer
 * run-facts suite), run authentication (the run-store suites) and the response
 * headers (the viewer route suites).
 */

import { rm } from "node:fs/promises";
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as resolve from "../../src/artifacts/resolve.js";
import * as profileLoad from "../../src/profile/load.js";
import type { LoadedProfile } from "../../src/profile/types.js";
import * as readVerified from "../../src/artifacts/read-verified.js";
import { gatherServableOutputWith, handleApiStageOutput, stageOutputReadsOver, type StageOutputReads } from "../../src/viewer/workflow-artifact.js";
import * as facts from "../../src/viewer/workflow-run-facts.js";
import {
  buildWorkflowRunProjection, buildWorkflowRunProjectionWith, providerTimeoutMsForStageCount, runProjectionReadsOver,
  type LiveStageHost, type RunProjectionReads, type WorkflowRunProjectionEnvelope,
} from "../../src/viewer/workflow-run-projection.js";
import * as runStore from "../../src/workflow-history/store.js";
import type { WorkflowRun } from "../../src/workflow-history/types.js";
import { researchArtifactProfile, startArtifactRun } from "../fixtures/artifact-seam-fixtures.js";

afterEach(() => { vi.restoreAllMocks(); });

let RUN: WorkflowRun, LOADED: LoadedProfile, ON_DISK: WorkflowRunProjectionEnvelope;

beforeAll(async () => {
  const { root, runId } = await startArtifactRun("viewer-projection-binding-", researchArtifactProfile());
  try {
    const read = await runStore.readRun(root, runId);
    if (read.status !== "ok") throw new Error("the minted run did not read back");
    [RUN, LOADED] = [read.run, await profileLoad.loadProfile(root)];
    ON_DISK = await buildWorkflowRunProjection(root, "build", runId) as WorkflowRunProjectionEnvelope;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Memory projection reads: `run` answers each run read, `digests` each profile load in turn (the last repeats). */
function projectionReads(log: string[], run: Awaited<ReturnType<typeof runStore.readRun>>, digests: string[] = [LOADED.digest]): RunProjectionReads {
  let loads = 0;
  return {
    readRun: async (runId) => { log.push(`run ${runId}`); return run; },
    loadProfile: async () => { log.push("profile"); return { ...LOADED, digest: digests[Math.min(loads++, digests.length - 1)]! }; },
  };
}

describe("the run projection's one body over memory reads", () => {
  it("V1 projects as the disk did, reading the run and the profile, then both again for the drift check", async () => {
    const log: string[] = [];
    const built = await buildWorkflowRunProjectionWith(projectionReads(log, { status: "ok", run: RUN }), "build", RUN.runId);
    expect(built).toEqual({ ...ON_DISK, generatedAt: expect.any(String) });
    expect([ON_DISK.stages.map((stage) => stage.stageId), log]).toEqual([["run"], [`run ${RUN.runId}`, "profile", `run ${RUN.runId}`, "profile"]]);
  });

  it("V2 an unreadable run or another workflow's run is a problem before the profile is loaded", async () => {
    const problem = async (read: Awaited<ReturnType<typeof runStore.readRun>>, workflowId = "build") => {
      const log: string[] = [];
      const built = await buildWorkflowRunProjectionWith(projectionReads(log, read), workflowId, "r");
      return ["problem" in built ? built.problem : built, log];
    };
    expect(await problem({ status: "absent" })).toEqual(["run is not readable (absent)", ["run r"]]);
    expect(await problem({ status: "unavailable", detail: "integrity" })).toEqual(["run is not readable (integrity)", ["run r"]]);
    expect(await problem({ status: "ok", run: RUN }, "other")).toEqual(['run belongs to workflow "build", not "other"', ["run r"]]);
  });

  it("V3 the live host gets each attempt's anchor and the stage budget; a drift retries and settles on a stable pass", async () => {
    const live = vi.fn<LiveStageHost>(async () => ({ stages: [], live: { outcome: "applied" } }));
    const log: string[] = [];
    const built = await buildWorkflowRunProjectionWith(projectionReads(log, { status: "ok", run: RUN }, ["d0", "d1", "d2"]), "build", RUN.runId, live);
    const budget = providerTimeoutMsForStageCount(RUN.stageLog.length);
    expect(live.mock.calls.map((call) => call.slice(1))).toEqual([
      [RUN, { stateVersion: RUN.stateVersion, profileDigest: "d0" }, budget], [RUN, { stateVersion: RUN.stateVersion, profileDigest: "d2" }, budget],
    ]);
    expect([live.mock.calls[0]![0], built]).toEqual([ON_DISK.stages, { ...ON_DISK, generatedAt: expect.any(String), stages: [], live: { outcome: "applied" } }]);
    expect(log.length).toBe(8);
  });

  it("V4 a profile that drifts on every attempt degrades, after three, to the recorded rows marked drifted", async () => {
    const live = vi.fn<LiveStageHost>(async () => ({ stages: [], live: { outcome: "applied" } }));
    const log: string[] = [];
    const digests = ["d0", "d1", "d2", "d3", "d4", "d5"];
    const built = await buildWorkflowRunProjectionWith(projectionReads(log, { status: "ok", run: RUN }, digests), "build", RUN.runId, live, 5);
    expect(built).toEqual({ ...ON_DISK, generatedAt: expect.any(String), live: { outcome: "drifted" } });
    expect([live.mock.calls.map((call) => [call[2].profileDigest, call[3]]), log.length]).toEqual([[["d0", 5], ["d2", 5], ["d4", 5]], 12]);
  });
});

const OUTPUT_REF = { artifactType: "experiment-result", slug: "r1", sha256: "a".repeat(64) };

/** Memory stage-output reads answering `answers`, each call logged. */
function outputReads(log: string[], answers: { run?: Awaited<ReturnType<typeof runStore.readRun>>; profile?: LoadedProfile | Error; health?: string } = {}): StageOutputReads {
  return {
    readRun: async (runId) => { log.push(`run ${runId}`); return answers.run ?? { status: "ok", run: { ...RUN, outputs: { run: OUTPUT_REF } } }; },
    loadProfile: async () => { log.push("profile"); if (answers.profile instanceof Error) throw answers.profile; return answers.profile ?? LOADED; },
    verifiedBody: async (_profile, ref) => {
      log.push(`verify ${ref.slug}`);
      return answers.health === undefined ? { health: "ok", bytes: Buffer.from("{}") } : { health: answers.health as never };
    },
  };
}

describe("the stage-output route's one body over memory reads", () => {
  const serve = async (answers: Parameters<typeof outputReads>[1] = {}, workflowId = "build") => {
    const log: string[] = [];
    const served = await gatherServableOutputWith(outputReads(log, answers), { workflowId, runId: "r", stageId: "run" });
    return ["problem" in served ? served.problem : served, log];
  };

  it("A1 serves the verified bytes under the type's fixed mapping after reading the run, the profile and the body", async () => {
    expect(await serve()).toEqual([{ bytes: Buffer.from("{}"), mapping: { contentType: "application/json; charset=utf-8", filename: "output.json" } }, ["run r", "profile", "verify r1"]]);
  });

  it("A2 refuses an unreadable, foreign or outputless run before the profile, an unservable kind or unverified body after it", async () => {
    expect(await serve({ run: { status: "absent" } })).toEqual(['run "r" is not readable', ["run r"]]);
    expect(await serve({}, "other")).toEqual(['run belongs to workflow "build", not "other"', ["run r"]]);
    expect(await serve({ run: { status: "ok", run: RUN } })).toEqual(['stage "run" has no verifiable recorded output', ["run r"]]);
    const textless = { ...LOADED, profile: { ...LOADED.profile, artifacts: {} } } as LoadedProfile;
    expect(await serve({ profile: textless })).toEqual(['artifact type "experiment-result" is not a servable content kind', ["run r", "profile"]]);
    expect(await serve({ health: "artifact-bytes-tampered" })).toEqual(["artifact did not verify (artifact-bytes-tampered)", ["run r", "profile", "verify r1"]]);
    expect(await serve({ profile: new Error("gone") })).toEqual(["the run or its artifact could not be read", ["run r", "profile"]]);
  });
});

describe("the bound compositions and the root forms", () => {
  it("B1 each composition calls its lower one body over its own seam", async () => {
    const runs = {} as never, profile = {} as never, store = {} as never;
    const readRunFrom = vi.spyOn(runStore, "readRunFrom").mockResolvedValue({ status: "absent" });
    const loadProfileFrom = vi.spyOn(profileLoad, "loadProfileFrom").mockResolvedValue(LOADED);
    const verified = vi.spyOn(resolve, "readVerifiedArtifactFrom").mockResolvedValue({ health: "ok", body: "{}" } as never);
    const reads = runProjectionReadsOver({ runs, profile });
    expect([await reads.readRun("r"), await reads.loadProfile()]).toEqual([{ status: "absent" }, LOADED]);
    const outputs = stageOutputReadsOver({ runs, profile, store });
    expect([await outputs.readRun("r"), await outputs.loadProfile(), await outputs.verifiedBody(LOADED.profile, OUTPUT_REF)])
      .toEqual([{ status: "absent" }, LOADED, { health: "ok", bytes: Buffer.from("{}") }]);
    expect([readRunFrom.mock.calls, loadProfileFrom.mock.calls, verified.mock.calls]).toEqual([
      [[runs, "r"], [runs, "r"]], [[profile], [profile]], [[store, LOADED.profile, OUTPUT_REF]],
    ]);
  });

  it("B2 the root forms reach the incumbent root readers and the live provider with exact arguments", async () => {
    const readRun = vi.spyOn(runStore, "readRun").mockResolvedValue({ status: "ok", run: { ...RUN, outputs: { run: OUTPUT_REF } } });
    const loadProfile = vi.spyOn(profileLoad, "loadProfile").mockResolvedValue(LOADED);
    const applied = vi.spyOn(facts, "applyLiveStageProvider").mockResolvedValue({ stages: [], live: { outcome: "applied" } });
    const body = vi.spyOn(readVerified, "readVerifiedArtifactBody").mockResolvedValue({ health: "ok", bytes: Buffer.from("{}") });
    const provider = vi.fn();
    await buildWorkflowRunProjection("/project", "build", "r", provider, 5);
    const anchor = { stateVersion: RUN.stateVersion, profileDigest: LOADED.digest };
    expect(applied.mock.calls.map((call) => call.slice(1))).toEqual([[provider, "/project", { ...RUN, outputs: { run: OUTPUT_REF } }, anchor, 5]]);
    const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
    await handleApiStageOutput(res as never, "/api/workflows/build/runs/r/stage/run/output", "/project");
    expect([readRun.mock.calls.length, readRun.mock.calls.every((call) => call.join() === "/project,r"), loadProfile.mock.calls]).toEqual([3, true, [["/project"], ["/project"], ["/project"]]]);
    expect([body.mock.calls, res.statusCode, res.end.mock.calls]).toEqual([[["/project", LOADED.profile, OUTPUT_REF]], 200, [[Buffer.from("{}")]]]);
  });
});
