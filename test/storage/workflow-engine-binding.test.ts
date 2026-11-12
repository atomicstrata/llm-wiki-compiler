/**
 * @file test/storage/workflow-engine-binding.test.ts
 * @description The local workflow engine's `…WithHost` bodies as WHOLE
 * consumers over a supplied host, with no project directory: every verb of
 * `createLocalWorkflowRuntime` is driven end to end over the one in-memory
 * `LocalWorkflowHost` of `workflow-memory-host.ts`.
 *
 * HOW IT IS BUILT. Each journey installs a fixture workflow profile as held
 * text, then calls the runtime's public verbs in sequence. The run records are
 * the signed texts the real run-store bodies wrote into the Map and read back,
 * so each step sees the previous step's record exactly as the engine left it.
 * Four journeys: (a) the lifecycle (start, an agent gate challenged and
 * approved, a human gate approved interactively, advance to completion); (b)
 * the terminal verbs on one run (fail, resume, cancel, then a refused resume),
 * and refusal and a verifier receipt stopping at their process-authority gate;
 * (c) the read verbs (list, show, events, status, the action catalog and one
 * action run); (d) adapt (a dry run that writes nothing, then the apply) and
 * the projection, both explicit and after each mutation.
 *
 * WHAT IS SHOWN. The recorded status and event trail after every verb, the
 * host members each verb reached (a member a journey does not use throws), and
 * that every record write happened inside a live mutation handle.
 *
 * Z1 shows the disk `createLocalWorkflowHost` supplies the same member groups
 * under the same core instance, so the journeys speak to the real contract.
 *
 * NOT SHOWN HERE: the disk host's own members (the lock, confinement); the `local-workflow-runtime-*` suites run the
 * same verbs over it on disk. The ACCEPTED refusal and verifier receipt need a
 * product-activated process authority and artifact observations, and stay with
 * `workflow-refused` and `workflow-verifier-receipt` on disk.
 */

import { describe, expect, it } from "bun:test";
import { createLocalWorkflowHost } from "../../src/local-workflow-host/index.js";
import { createLocalWorkflowRuntime } from "../../src/workflows/runtime.js";
import { RunNotActiveError } from "../../src/workflows/errors.js";
import type { WorkflowRun } from "../../src/workflow-history/types.js";
import { ACTION_PROFILE, ADAPT_BUILD_STAGES, ADAPT_RENAMED_STAGES, buildWorkflowProfile, experimentPageOutput, WORKFLOW_PROFILE } from "../fixtures/workflow-profile.js";
import { memoryWorkflowHost, type HostWorld } from "./workflow-memory-host.js";
import type { ProfilePack } from "../../src/profile/types.js";

const ROOT = "/memory/project";
/**
 * The lifecycle's trail, from the source contract: `startWorkflowWithHost` records
 * `workflow-start`, each `approveGateWithHost` one `gate-approved` (gate.ts), and
 * each `advanceWorkflowWithHost` one `stage-advanced` (advance.ts), the completing
 * advance included; completion is the run's status, not a further event.
 */
const TRAIL_A = ["workflow-start", "gate-approved", "stage-advanced", "gate-approved", "stage-advanced"];
/**
 * The host members the lifecycle reached: the store, the profile and authority
 * check, the projection and the terminal, and nothing else. `humanGateEnabled`
 * is consulted only by `runActionWithHost` (run-action.ts), never by a gate
 * approval, and no lifecycle verb reads an observation or a domain effect.
 */
const REACHED_A = ["history.exists", "history.list", "history.read", "profiles.assert", "profiles.load", "profiles.resolve", "projections.write",
  "records.write", "terminal.confirm", "terminal.io", "tx.close", "tx.open"];

/** A runtime over a fresh memory host holding `pack`. */
function runtimeOver(pack: ProfilePack, world: HostWorld = {}) {
  const memory = memoryWorkflowHost(pack, world);
  return { ...memory, runtime: createLocalWorkflowRuntime(memory.host) };
}

/** The event types of a run, in order. */
function trail(run: WorkflowRun): string[] { return run.events.map((event) => event.type); }
/** The distinct host members a journey reached, in first-use order. */
function reached(log: string[]): string[] { return [...new Set(log)]; }

describe("the workflow engine over a supplied host", () => {
  it("(a) starts, challenges and approves an agent gate, approves a human gate interactively, and advances to completion", async () => {
    const stages = [{ id: "review", reads: [], writes: [], gate: "agent:review" }, { id: "signoff", reads: [], writes: [], gate: "human:signoff" }];
    const { runtime, runs, log } = runtimeOver(buildWorkflowProfile(stages), { confirm: true });
    const started = await runtime.start({ root: ROOT, workflowId: "build", inputs: {} });
    expect([started.status, started.currentStage, [...runs.keys()]]).toEqual(["pending", "review", [started.runId]]);
    expect(await runtime.gateChallenge(ROOT, started.runId, "review")).toEqual({ kind: "agent" });
    expect((await runtime.approveGate(ROOT, started.runId, "review", { actorKind: "agent" })).satisfiedGates).toEqual(["agent:review"]);
    expect((await runtime.advance(ROOT, started.runId)).outcome).toBe("advanced");
    expect((await runtime.approveHumanGateInteractively(ROOT, started.runId, "signoff")).satisfiedGates).toEqual(["agent:review", "human:signoff"]);
    const done = await runtime.advance(ROOT, started.runId);
    expect([done.outcome, done.run.status, done.run.currentStage]).toEqual(["completed", "completed", null]);
    expect(trail(done.run)).toEqual(TRAIL_A);
    expect(reached(log).sort()).toEqual(REACHED_A);
  });

  it("(a) a human gate the terminal does not confirm is refused and records nothing", async () => {
    const { runtime, runs, log } = runtimeOver(buildWorkflowProfile([{ id: "signoff", reads: [], writes: [], gate: "human:signoff" }]), { confirm: false });
    const started = await runtime.start({ root: ROOT, workflowId: "build", inputs: {} });
    const before = runs.get(started.runId);
    await expect(runtime.approveHumanGateInteractively(ROOT, started.runId, "signoff")).rejects.toThrow("human gate was not interactively confirmed");
    expect([runs.get(started.runId), log.filter((call) => call.startsWith("records."))]).toEqual([before, ["records.write"]]);
  });

  it("(a) submits a page output: parked for review without the trust grant, applied and the gate satisfied with it", async () => {
    const world: HostWorld = {};
    const { runtime, log } = runtimeOver(buildWorkflowProfile([{ id: "draft", reads: [], writes: ["experiments"], gate: "trust:review" }]), world);
    const run = await runtime.start({ root: ROOT, workflowId: "build", inputs: {} });
    const parked = await runtime.submit(ROOT, run.runId, experimentPageOutput("example"));
    expect([parked.applied, parked.decision, parked.run.satisfiedGates, log.includes("pages.apply")]).toEqual([false, "stage-for-review", [], false]);
    world.trusted = true;
    const applied = await runtime.submit(ROOT, run.runId, experimentPageOutput("example"));
    expect([applied.applied, applied.run.satisfiedGates, applied.run.pendingOutput]).toEqual([true, ["trust:review"], undefined]);
    expect(log.filter((call) => call.startsWith("pages."))).toEqual(["pages.plan", "pages.plan", "pages.validate", "pages.apply"]);
  });

  it("(b) fails, resumes and cancels one run with the retained event trail, then refuses a resume", async () => {
    const { runtime, log } = runtimeOver(WORKFLOW_PROFILE);
    const started = await runtime.start({ root: ROOT, workflowId: "build", inputs: { topic: "retained" } });
    expect((await runtime.fail(ROOT, started.runId, "retry this stage")).status).toBe("failed");
    expect((await runtime.resume(ROOT, started.runId)).status).toBe("running");
    const cancelled = await runtime.cancel(ROOT, started.runId);
    expect([cancelled.status, cancelled.inputs, trail(cancelled)]).toEqual(["cancelled", { topic: "retained" }, ["workflow-start", "run-failed", "run-resumed", "run-cancelled"]]);
    await expect(runtime.resume(ROOT, started.runId)).rejects.toBeInstanceOf(RunNotActiveError);
    expect(log.filter((call) => call.startsWith("records."))).toEqual(["records.write", "records.writeCandidates", "records.write", "records.writeCandidates"]);
  });

  it("(b) refusal and a verifier receipt without a process authority refuse under the lock and record nothing", async () => {
    const { runtime, runs, log } = runtimeOver(WORKFLOW_PROFILE);
    const started = await runtime.start({ root: ROOT, workflowId: "build", inputs: {} });
    const before = runs.get(started.runId);
    await expect(runtime.refuse(ROOT, started.runId, { verifierResult: "not-approvable", evidenceRef: "review-report/one@sha256:00" }))
      .rejects.toThrow("workflow refusal is process-authority-required");
    await expect(runtime.mintVerifierReceipt(ROOT, started.runId, "draft", "review-report/one@sha256:00", "verifier", {} as never))
      .rejects.toThrow("workflow verifier refused: process-authority-missing");
    expect([runs.get(started.runId), log.filter((call) => call.startsWith("observations.") || call === "records.write")]).toEqual([before, ["records.write"]]);
  });

  it("(c) reads the workflows, one run's events and status, the action catalog, and runs one action", async () => {
    const { runtime } = runtimeOver(ACTION_PROFILE, { grant: "trusted-write", trusted: true });
    expect(await runtime.list(ROOT)).toEqual([{ workflowId: "build", stageIds: ["draft"] }]);
    expect(await runtime.show(ROOT, "build")).toMatchObject({ workflowId: "build", stages: [{ id: "draft" }], actions: ["build.start"] });
    expect((await runtime.listActions(ROOT)).map(({ actionId }) => actionId)).toEqual(["build.start"]);
    expect(await runtime.showAction(ROOT, "build.start")).toMatchObject({ actionId: "build.start", effectivePermissions: { sdk: "trusted-write", mcp: "staged-write" } });
    const ran = await runtime.runAction(ROOT, "build.start", {}, "sdk");
    expect(ran).toMatchObject({ actionId: "build.start", effectivePermission: "trusted-write", result: { status: "pending", currentStage: "draft" } });
    const runId = (ran.result as WorkflowRun).runId;
    expect((await runtime.events(ROOT, runId)).map((event: { type: string }) => event.type)).toEqual(["workflow-start"]);
    expect(await runtime.status(ROOT, runId)).toMatchObject([{ runId, classification: expect.any(String) }]);
  });

  it("(d) adapts a run (a dry run writes nothing, then the apply) and projects it explicitly and after each mutation", async () => {
    const { runtime, runs, projections, install } = runtimeOver(buildWorkflowProfile(ADAPT_BUILD_STAGES));
    const run = await runtime.start({ root: ROOT, workflowId: "build", inputs: {} });
    install(buildWorkflowProfile(ADAPT_RENAMED_STAGES));
    const before = runs.get(run.runId);
    expect(await runtime.adaptDryRun(ROOT, run.runId)).toMatchObject([{ lossless: true, stageMapping: [{ from: "draft", to: "compose" }, { from: "run", to: "run" }] }]);
    expect(runs.get(run.runId)).toBe(before);
    const adapted = await runtime.adaptApply(ROOT, run.runId);
    expect([adapted.currentStage, trail(adapted).at(-1)]).toEqual(["compose", "workflow-adapted"]);
    expect(projections.get("build")).toContain("currentStage: compose");
    expect(await runtime.project(ROOT, run.runId)).toEqual({ status: "written", path: "memory:wiki/build.md" });
  });
});

describe("the disk host", () => {
  it("Z1 wires the same member groups the memory host supplies, under the same core instance", () => {
    const disk = createLocalWorkflowHost() as unknown as Record<string, unknown>;
    const memory = memoryWorkflowHost(WORKFLOW_PROFILE).host as unknown as Record<string, unknown>;
    const groups = ["terminal", "domain", "projections", "authority", "profiles", "history", "records", "pages"];
    const shape = (host: Record<string, unknown>) => [host.coreInstance, ...groups.map((group) => Object.keys(host[group] as object).sort())];
    expect(shape(memory)).toEqual(shape(disk));
  });
});
