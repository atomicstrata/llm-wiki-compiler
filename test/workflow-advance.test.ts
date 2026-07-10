/**
 * @file test/workflow-advance.test.ts
 * @description Behavioural tests for the `advance` run-lifecycle operation.
 *
 * Covers: advancing a 2-stage no-gate workflow stage by stage to completion (with
 * `stage-advanced` events + stateVersion bumps); parking an unsatisfied
 * `human:`-gated stage as `awaiting-gate` (no progress); parking a write/`trust:`
 * stage as `awaiting-output` until a successful `submitStageOutput`, then advancing
 * (the integration this slice adds); and the fail-closed read/terminal/lock guards
 * ({@link RunUnavailableError}, {@link RunNotActiveError}, {@link LockBusyError}).
 */

import { describe, it, expect } from "vitest";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { buildWorkflowProfile, installWorkflowProfile } from "./fixtures/workflow-profile.js";
import { startWorkflow, UnknownWorkflowError } from "../src/workflows/start.js";
import { advanceWorkflow } from "../src/workflows/advance.js";
import { approveGate } from "../src/workflows/gate.js";
import { submitStageOutput, type StageOutput } from "../src/workflows/stage-output.js";
import { TRUSTED_WRITE_ENV_VAR } from "../src/workflows/trusted-write.js";
import { cancelWorkflow } from "../src/workflows/cancel.js";
import { RunUnavailableError, RunNotActiveError } from "../src/workflows/errors.js";
import { acquireLock, releaseLock, LockBusyError } from "../src/utils/lock.js";
import { signRun } from "./fixtures/run-integrity.js";
import type { WorkflowStageDef } from "../src/profile/types.js";
import type { WorkflowRun } from "../src/workflows/types.js";

/** A page output naming `experiments/<slug>` with a minimal valid body. */
function pageOutput(slug: string): StageOutput {
  return { kind: "page", entityType: "experiments", slug, body: `---\ntitle: ${slug}\n---\nbody` };
}

/** Two read-only no-gate stages — both fully advanceable in this slice. */
const NO_GATE_STAGES: WorkflowStageDef[] = [
  { id: "review", reads: ["ideas"], writes: [] },
  { id: "publish", reads: ["experiments"], writes: [] },
];

/** Start a `build` run against `stages` in a fresh temp root. */
async function startBuild(prefix: string, stages: WorkflowStageDef[]) {
  const root = await makeTempRoot(prefix);
  await installWorkflowProfile(root, buildWorkflowProfile(stages));
  const run = await startWorkflow(root, "build", {});
  return { root, runId: run.runId };
}

/**
 * Hand-edit the persisted run file, merging `patch` over its parsed JSON and
 * RE-SIGNING with the project key (the trust floor is local-key access, so this
 * simulates a legitimately-stored record edited in place, keeping the DOWNSTREAM
 * op guards under test rather than tripping the integrity gate).
 */
async function patchRunFile(root: string, runId: string, patch: Record<string, unknown>): Promise<void> {
  const leaf = path.join(root, ".llmwiki", "workflows", "runs", `${runId}.json`);
  const seed = JSON.parse(await readFile(leaf, "utf8"));
  const signed = await signRun(root, { ...seed, ...patch, integrity: undefined } as WorkflowRun);
  await writeFile(leaf, JSON.stringify(signed), "utf8");
}

describe("advanceWorkflow — no-gate progression", () => {
  it("advances a 2-stage no-gate workflow stage by stage to completion", async () => {
    const { root, runId } = await startBuild("wf-adv-progress", NO_GATE_STAGES);
    const first = await advanceWorkflow(root, runId);
    expect(first.outcome).toBe("advanced");
    expect(first.run.status).toBe("running");
    expect(first.run.currentStage).toBe("publish");
    expect(first.run.stageLog).toEqual([
      { stageId: "review", status: "completed" },
      { stageId: "publish", status: "running" },
    ]);
    const second = await advanceWorkflow(root, runId);
    expect(second.outcome).toBe("completed");
    expect(second.run.status).toBe("completed");
    expect(second.run.currentStage).toBeNull();
    expect(second.run.stageLog[1]).toEqual({ stageId: "publish", status: "completed" });
  });

  it("records a stage-advanced event and bumps stateVersion on each advance", async () => {
    const { root, runId } = await startBuild("wf-adv-events", NO_GATE_STAGES);
    const first = await advanceWorkflow(root, runId);
    expect(first.run.stateVersion).toBe(1);
    const advanced = first.run.events.filter((e) => e.type === "stage-advanced");
    expect(advanced).toHaveLength(1);
    expect(advanced[0]).toMatchObject({ stageId: "review", actorKind: "system", stateVersionAfter: 1 });
    const second = await advanceWorkflow(root, runId);
    expect(second.run.stateVersion).toBe(2);
    expect(second.run.events.filter((e) => e.type === "stage-advanced")).toHaveLength(2);
  });
});

describe("advanceWorkflow — gate parking", () => {
  it("parks a stage with an unsatisfied human: gate as awaiting-gate and flips pending to running", async () => {
    const stages: WorkflowStageDef[] = [
      { id: "review", reads: ["ideas"], writes: [], gate: "human:approve" },
      { id: "publish", reads: ["experiments"], writes: [] },
    ];
    const { root, runId } = await startBuild("wf-adv-gate", stages);
    const result = await advanceWorkflow(root, runId);
    expect(result.outcome).toBe("awaiting-gate");
    expect(result.run.currentStage).toBe("review");
    expect(result.run.stageLog[0]).toEqual({ stageId: "review", status: "awaiting-gate" });
    expect(result.run.status).toBe("running");
    expect(result.run.events.filter((e) => e.type === "stage-advanced")).toHaveLength(0);
  });

  it("re-advancing an already-parked gated run is idempotent (no version/event churn)", async () => {
    const stages: WorkflowStageDef[] = [{ id: "review", reads: ["ideas"], writes: [], gate: "human:approve" }];
    const { root, runId } = await startBuild("wf-adv-gate-idem", stages);
    const first = await advanceWorkflow(root, runId);
    expect(first.outcome).toBe("awaiting-gate");
    expect(first.run.status).toBe("running");
    const versionAfterPark = first.run.stateVersion;
    const eventsAfterPark = first.run.events.length;
    const second = await advanceWorkflow(root, runId);
    expect(second.outcome).toBe("awaiting-gate");
    expect(second.run.stateVersion).toBe(versionAfterPark);
    expect(second.run.events.length).toBe(eventsAfterPark);
  });
});

describe("advanceWorkflow — write/trust stages park awaiting-output", () => {
  it("parks a trust:-gated write stage as awaiting-output before any submit (no throw, no progress)", async () => {
    const stages: WorkflowStageDef[] = [{ id: "run", reads: ["ideas"], writes: ["experiments"], gate: "trust:high" }];
    const { root, runId } = await startBuild("wf-adv-trust", stages);
    const result = await advanceWorkflow(root, runId);
    expect(result.outcome).toBe("awaiting-output");
    expect(result.run.status).toBe("running");
    expect(result.run.currentStage).toBe("run");
    expect(result.run.events.filter((e) => e.type === "stage-advanced")).toHaveLength(0);
  });

  it("completes a trust:-gated write stage after a successful submit applies + satisfies it", async () => {
    // A `trust:`-gated apply requires the operator's out-of-band trusted-write
    // grant (C3); without it the clean write STAGES and never satisfies the gate.
    process.env[TRUSTED_WRITE_ENV_VAR] = "research";
    try {
      const stages: WorkflowStageDef[] = [{ id: "run", reads: ["ideas"], writes: ["experiments"], gate: "trust:high" }];
      const { root, runId } = await startBuild("wf-adv-trust-ok", stages);
      expect((await submitStageOutput(root, runId, pageOutput("alpha"))).applied).toBe(true);
      const result = await advanceWorkflow(root, runId);
      expect(result.outcome).toBe("completed");
      expect(result.run.status).toBe("completed");
    } finally {
      delete process.env[TRUSTED_WRITE_ENV_VAR];
    }
  });

  it("parks a write-only (no gate) stage awaiting-output, then advances after the output is recorded", async () => {
    const stages: WorkflowStageDef[] = [
      { id: "run", reads: ["ideas"], writes: ["experiments"] },
      { id: "publish", reads: ["experiments"], writes: [] },
    ];
    const { root, runId } = await startBuild("wf-adv-write-only", stages);
    expect((await advanceWorkflow(root, runId)).outcome).toBe("awaiting-output");
    expect((await submitStageOutput(root, runId, pageOutput("beta"))).applied).toBe(true);
    const result = await advanceWorkflow(root, runId);
    expect(result.outcome).toBe("advanced");
    expect(result.run.currentStage).toBe("publish");
  });

  it("leaves a write stage parked (not advanced) when the submit was staged, not applied", async () => {
    const stages: WorkflowStageDef[] = [{ id: "run", reads: ["ideas"], writes: ["experiments"], gate: "trust:high" }];
    const { root, runId } = await startBuild("wf-adv-staged", stages);
    const target = path.join(root, "wiki", "experiments", "dup.md");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "pre-existing", "utf8");
    expect((await submitStageOutput(root, runId, pageOutput("dup"))).applied).toBe(false);
    expect((await advanceWorkflow(root, runId)).outcome).toBe("awaiting-output");
  });
});

describe("advanceWorkflow — falsy recorded output counts as recorded", () => {
  it("treats a recorded falsy output (0) on a write stage as satisfied, not parked", async () => {
    const stages: WorkflowStageDef[] = [
      { id: "run", reads: ["ideas"], writes: ["experiments"] },
      { id: "publish", reads: ["experiments"], writes: [] },
    ];
    const { root, runId } = await startBuild("wf-adv-falsy-output", stages);
    await patchRunFile(root, runId, { outputs: { run: 0 } });
    const { outcome, run } = await advanceWorkflow(root, runId);
    expect(outcome).toBe("advanced"); // not parked awaiting-output despite the falsy 0
    expect(run.stageLog.find((e) => e.stageId === "run")?.status).toBe("completed");
  });
});

describe("advanceWorkflow — human gate unchanged", () => {
  it("parks a human: gate awaiting-gate, then advances after approveGate", async () => {
    const stages: WorkflowStageDef[] = [
      { id: "review", reads: ["ideas"], writes: [], gate: "human:approve" },
      { id: "publish", reads: ["experiments"], writes: [] },
    ];
    const { root, runId } = await startBuild("wf-adv-human", stages);
    expect((await advanceWorkflow(root, runId)).outcome).toBe("awaiting-gate");
    await approveGate(root, runId, "approve", { actorKind: "human" });
    const result = await advanceWorkflow(root, runId);
    expect(result.outcome).toBe("advanced");
    expect(result.run.currentStage).toBe("publish");
  });
});

describe("advanceWorkflow — fail-closed guards", () => {
  it("throws RunNotActiveError when advancing a terminal (cancelled) run", async () => {
    const { root, runId } = await startBuild("wf-adv-terminal", NO_GATE_STAGES);
    await cancelWorkflow(root, runId);
    await expect(advanceWorkflow(root, runId)).rejects.toBeInstanceOf(RunNotActiveError);
  });

  it("throws RunUnavailableError for an absent run id", async () => {
    const root = await makeTempRoot("wf-adv-absent");
    await installWorkflowProfile(root, buildWorkflowProfile(NO_GATE_STAGES));
    await expect(advanceWorkflow(root, "build-2026-01-01-9999")).rejects.toBeInstanceOf(RunUnavailableError);
  });

  it("throws UnknownWorkflowError (not a TypeError) for a forged run whose workflowId is 'constructor'", async () => {
    const { root, runId } = await startBuild("wf-adv-proto", NO_GATE_STAGES);
    await patchRunFile(root, runId, { workflowId: "constructor" });
    await expect(advanceWorkflow(root, runId)).rejects.toBeInstanceOf(UnknownWorkflowError);
  });

  it("throws LockBusyError after the bounded timeout when the lock stays held (not immediately)", async () => {
    const { root, runId } = await startBuild("wf-adv-busy", NO_GATE_STAGES);
    expect(await acquireLock(root, { quiet: true })).toBe(true);
    try {
      // Bounded-blocking: retries then throws after the short timeout (consistent contract).
      await expect(advanceWorkflow(root, runId, { timeoutMs: 60, intervalMs: 5 })).rejects.toBeInstanceOf(LockBusyError);
    } finally {
      await releaseLock(root);
    }
  });

  it("a transiently-held lock RETRIES then succeeds (bounded-blocking, like submit)", async () => {
    const { root, runId } = await startBuild("wf-adv-contend", NO_GATE_STAGES);
    expect(await acquireLock(root, { quiet: true })).toBe(true);
    // Free the lock shortly after advance starts polling; it must then succeed.
    setTimeout(() => { void releaseLock(root); }, 40);
    const { run } = await advanceWorkflow(root, runId, { timeoutMs: 2000, intervalMs: 5 });
    expect(run.runId).toBe(runId);
  });
});
