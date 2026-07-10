/**
 * @file test/workflow-cancel-resume.test.ts
 * @description Behavioural tests for the cancel / fail / resume lifecycle ops.
 *
 * Covers: cancelling an active run (terminal `cancelled` + `run-cancelled` event +
 * null current stage) and re-cancelling a terminal run ({@link RunNotActiveError});
 * failing an active run (terminal `failed` + current stage `failed` + `run-failed`
 * event with detail); resuming a failed run (back to `running`, `run-resumed`
 * event), resuming a running run (unchanged, no new event), and resuming a
 * completed run ({@link RunNotActiveError}).
 */

import { describe, it, expect } from "vitest";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { buildWorkflowProfile, installWorkflowProfile } from "./fixtures/workflow-profile.js";
import { createWiki } from "../src/sdk/wiki.js";
import { startWorkflow } from "../src/workflows/start.js";
import { advanceWorkflow } from "../src/workflows/advance.js";
import { cancelWorkflow } from "../src/workflows/cancel.js";
import { failWorkflow } from "../src/workflows/fail.js";
import { resumeWorkflow } from "../src/workflows/resume.js";
import { RunNotActiveError } from "../src/workflows/errors.js";
import { readRun } from "../src/workflows/store.js";
import { WorkflowFieldTooLongError } from "../src/workflows/field-limits.js";
import { MAX_WORKFLOW_DETAIL_CHARS } from "../src/utils/constants.js";
import type { WorkflowStageDef } from "../src/profile/types.js";

/** Two read-only no-gate stages — both fully advanceable in this slice. */
const STAGES: WorkflowStageDef[] = [
  { id: "review", reads: ["ideas"], writes: [] },
  { id: "publish", reads: ["experiments"], writes: [] },
];

/** Start a `build` run in a fresh temp root. */
async function startBuild(prefix: string) {
  const root = await makeTempRoot(prefix);
  await installWorkflowProfile(root, buildWorkflowProfile(STAGES));
  const run = await startWorkflow(root, "build", {});
  return { root, runId: run.runId };
}

describe("cancelWorkflow", () => {
  it("cancels an active run with a run-cancelled event and null current stage", async () => {
    const { root, runId } = await startBuild("wf-cancel-ok");
    const run = await cancelWorkflow(root, runId);
    expect(run.status).toBe("cancelled");
    expect(run.currentStage).toBeNull();
    expect(run.events.at(-1)).toMatchObject({ type: "run-cancelled", actorKind: "system" });
    expect(run.stateVersion).toBe(1);
  });

  it("throws RunNotActiveError when cancelling a terminal run", async () => {
    const { root, runId } = await startBuild("wf-cancel-terminal");
    await cancelWorkflow(root, runId);
    await expect(cancelWorkflow(root, runId)).rejects.toBeInstanceOf(RunNotActiveError);
  });
});

describe("failWorkflow", () => {
  it("fails an active run with the current stage failed and a run-failed event with detail", async () => {
    const { root, runId } = await startBuild("wf-fail-ok");
    const run = await failWorkflow(root, runId, "boom");
    expect(run.status).toBe("failed");
    expect(run.stageLog[0]).toEqual({ stageId: "review", status: "failed" });
    expect(run.events.at(-1)).toMatchObject({ type: "run-failed", actorKind: "system", detail: "boom" });
  });

  // FIX 2: an over-long detail is rejected (typed) BEFORE any write — the run stays active.
  it("rejects an over-long detail (typed) and leaves the run active", async () => {
    const { root, runId } = await startBuild("wf-fail-detail-cap");
    const detail = "d".repeat(MAX_WORKFLOW_DETAIL_CHARS + 1);
    await expect(failWorkflow(root, runId, detail)).rejects.toBeInstanceOf(WorkflowFieldTooLongError);
    const read = await readRun(root, runId);
    expect(read.status === "ok" && read.run.status).not.toBe("failed");
  });
});

describe("resumeWorkflow", () => {
  it("resumes a failed run back to running with a run-resumed event", async () => {
    const { root, runId } = await startBuild("wf-resume-failed");
    await failWorkflow(root, runId, "boom");
    const run = await resumeWorkflow(root, runId);
    expect(run.status).toBe("running");
    expect(run.stageLog[0]).toEqual({ stageId: "review", status: "running" });
    expect(run.events.at(-1)).toMatchObject({ type: "run-resumed", actorKind: "system" });
  });

  it("returns a running/pending run unchanged with no new event", async () => {
    const { root, runId } = await startBuild("wf-resume-active");
    const before = await advanceWorkflow(root, runId); // now currentStage publish
    const run = await resumeWorkflow(root, runId);
    expect(run.stateVersion).toBe(before.run.stateVersion);
    expect(run.events.filter((e) => e.type === "run-resumed")).toHaveLength(0);
  });

  it("throws RunNotActiveError when resuming a completed run", async () => {
    const { root, runId } = await startBuild("wf-resume-completed");
    await advanceWorkflow(root, runId);
    await advanceWorkflow(root, runId); // completes the 2-stage run
    await expect(resumeWorkflow(root, runId)).rejects.toBeInstanceOf(RunNotActiveError);
  });
});

// BUG 1 (H2): the SDK facade exposes the flat `failWorkflow` so `failed` is reachable.
describe("SDK failWorkflow", () => {
  it("fails a run via the facade, recording the detail on the run-failed event", async () => {
    const { root, runId } = await startBuild("wf-sdk-fail");
    const wiki = createWiki({ root });
    const run = await wiki.failWorkflow(runId, "boom");
    expect(run.status).toBe("failed");
    expect(run.events.at(-1)).toMatchObject({ type: "run-failed", detail: "boom" });
  });
});
