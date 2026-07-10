/**
 * @file test/workflow-show-events.test.ts
 * @description Tests for the read-only `showWorkflow` and `listRunEvents` ops.
 *
 * `showWorkflow` surfaces a workflow's per-stage `reads`/`writes`/`gate`/
 * `previousIds`, its `projectionFile`, and the actions targeting it; an unknown id
 * throws `UnknownWorkflowError`. `listRunEvents` returns a run's recorded `events[]`
 * (incl. the genesis `workflow-start` and a `stage-advanced` after an advance); an
 * unknown run throws `RunUnavailableError`.
 */

import { describe, it, expect } from "vitest";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { buildWorkflowProfile, installWorkflowProfile } from "./fixtures/workflow-profile.js";
import { showWorkflow } from "../src/workflows/show.js";
import { listRunEvents } from "../src/workflows/run-events.js";
import { startWorkflow, UnknownWorkflowError } from "../src/workflows/start.js";
import { advanceWorkflow } from "../src/workflows/advance.js";
import { RunUnavailableError } from "../src/workflows/errors.js";
import type { WorkflowStageDef } from "../src/profile/types.js";

/** A two-stage `build` with a gate on the second stage. */
const STAGES: WorkflowStageDef[] = [
  { id: "draft", reads: ["ideas"], writes: ["ideas"] },
  { id: "run", reads: ["ideas"], writes: [], gate: "agent:reviewer", previousIds: ["execute"] },
];

describe("showWorkflow", () => {
  it("surfaces each stage's reads/writes/gate/previousIds for a declared workflow", async () => {
    const root = await makeTempRoot("wf-show");
    await installWorkflowProfile(root, buildWorkflowProfile(STAGES));
    const detail = await showWorkflow(root, "build");
    expect(detail.workflowId).toBe("build");
    expect(detail.stages).toEqual([
      { id: "draft", reads: ["ideas"], writes: ["ideas"] },
      { id: "run", reads: ["ideas"], writes: [], gate: "agent:reviewer", previousIds: ["execute"] },
    ]);
  });

  it("throws UnknownWorkflowError for an undeclared workflow id", async () => {
    const root = await makeTempRoot("wf-show-unknown");
    await installWorkflowProfile(root, buildWorkflowProfile(STAGES));
    await expect(showWorkflow(root, "nope")).rejects.toBeInstanceOf(UnknownWorkflowError);
  });
});

describe("listRunEvents", () => {
  it("returns the genesis workflow-start plus a stage-advanced after an advance", async () => {
    const root = await makeTempRoot("wf-events");
    // Read-only stages so the first advance COMPLETES the stage (records stage-advanced).
    await installWorkflowProfile(root, buildWorkflowProfile([
      { id: "draft", reads: ["ideas"], writes: [] },
      { id: "run", reads: ["ideas"], writes: [] },
    ]));
    const run = await startWorkflow(root, "build", {});
    await advanceWorkflow(root, run.runId);
    const events = await listRunEvents(root, run.runId);
    const types = events.map((e) => e.type);
    expect(types).toContain("workflow-start");
    expect(types).toContain("stage-advanced");
  });

  it("throws RunUnavailableError for an unknown run id", async () => {
    const root = await makeTempRoot("wf-events-unknown");
    await installWorkflowProfile(root, buildWorkflowProfile(STAGES));
    await expect(listRunEvents(root, "build-2026-01-01-9999")).rejects.toBeInstanceOf(RunUnavailableError);
  });
});
