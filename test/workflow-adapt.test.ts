/**
 * @file test/workflow-adapt.test.ts
 * @description Tests for the pure adaptation primitives and the read-only
 * `adapt --dry-run`: `mapStageId` (identity / previousIds / unmappable),
 * `computeAdaptationPlan` (mapping, unmappable, lossless, recorded digests), and
 * `adaptDryRun` (reports a plan for a renamed-stage run, a no-change plan for a
 * current run, and mutates NOTHING on disk).
 */

import { describe, it, expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { buildWorkflowProfile, installWorkflowProfile } from "./fixtures/workflow-profile.js";
import { startWorkflow } from "../src/workflows/start.js";
import { mapStageId, computeAdaptationPlan, adaptDryRun, AdaptDryRunError } from "../src/workflows/adapt.js";
import { workflowDefDigest } from "../src/profile/workflow-digest.js";
import type { WorkflowStageDef, WorkflowDef } from "../src/profile/types.js";
import { WORKFLOW_RUN_SCHEMA_VERSION, type WorkflowRun } from "../src/workflows/types.js";

/** The default two-stage `build` workflow stages. */
const BUILD_STAGES: WorkflowStageDef[] = [
  { id: "draft", reads: ["ideas"], writes: ["ideas"] },
  { id: "run", reads: ["ideas"], writes: ["experiments"] },
];

/** The `build` def renaming `draft`→`compose` via previousIds (digest differs). */
const RENAMED_STAGES: WorkflowStageDef[] = [
  { id: "compose", reads: ["ideas"], writes: ["ideas"], previousIds: ["draft"] },
  { id: "run", reads: ["ideas"], writes: ["experiments"] },
];

/** The current `build` def under the renamed stages, as a {@link WorkflowDef}. */
const renamedDef: WorkflowDef = { stages: RENAMED_STAGES };

/** A minimal run record on stage `currentStage` against the default `build` def. */
function runOn(currentStage: string | null, stageIds: string[]): WorkflowRun {
  return {
    schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION, runId: "build-2026-01-01-abcd", workflowId: "build",
    workflowDigest: "old-digest", profileDigest: "p", knownStageIds: stageIds,
    status: "running", currentStage,
    stageLog: stageIds.map((id) => ({ stageId: id, status: "pending" })),
    events: [], satisfiedGates: [], inputs: {}, outputs: {},
    stateVersion: 0, startedAt: "t", updatedAt: "t",
  };
}

describe("mapStageId", () => {
  it("maps an unchanged stage id to itself (identity)", () => {
    expect(mapStageId("run", renamedDef)).toBe("run");
  });

  it("maps an old id to its new id via previousIds", () => {
    expect(mapStageId("draft", renamedDef)).toBe("compose");
  });

  it("maps an unmappable id to null", () => {
    expect(mapStageId("ghost", renamedDef)).toBeNull();
  });
});

describe("computeAdaptationPlan", () => {
  it("records every mappable id (identity + renamed) and the digests", () => {
    const run = runOn("draft", ["draft", "run"]);
    const plan = computeAdaptationPlan(run, renamedDef);
    expect(plan.lossless).toBe(true);
    expect(plan.unmappable).toEqual([]);
    expect(plan.stageMapping).toContainEqual({ from: "draft", to: "compose" });
    expect(plan.stageMapping).toContainEqual({ from: "run", to: "run" });
    expect(plan.oldDigest).toBe("old-digest");
    expect(plan.newDigest).toBe(workflowDefDigest(renamedDef));
  });

  it("flags an unmappable id and reports lossless false", () => {
    const run = runOn("ghost", ["ghost", "run"]);
    const plan = computeAdaptationPlan(run, renamedDef);
    expect(plan.lossless).toBe(false);
    expect(plan.unmappable).toContain("ghost");
  });
});

describe("adaptDryRun", () => {
  it("reports a lossless plan for a renamed-stage run and changes nothing on disk", async () => {
    const root = await makeTempRoot("wf-adapt-dry");
    await installWorkflowProfile(root, buildWorkflowProfile(BUILD_STAGES));
    const run = await startWorkflow(root, "build", {});
    const leaf = path.join(root, ".llmwiki", "workflows", "runs", `${run.runId}.json`);
    const before = await readFile(leaf, "utf8");
    await installWorkflowProfile(root, buildWorkflowProfile(RENAMED_STAGES));
    const plans = await adaptDryRun(root, run.runId);
    expect(plans).toHaveLength(1);
    expect(plans[0].lossless).toBe(true);
    expect(plans[0].stageMapping).toContainEqual({ from: "draft", to: "compose" });
    expect(await readFile(leaf, "utf8")).toBe(before);
  });

  it("returns a no-change identity plan for a current run", async () => {
    const root = await makeTempRoot("wf-adapt-current");
    await installWorkflowProfile(root, buildWorkflowProfile(BUILD_STAGES));
    const run = await startWorkflow(root, "build", {});
    const plans = await adaptDryRun(root, run.runId);
    expect(plans[0].lossless).toBe(true);
    expect(plans[0].stageMapping.every((m) => m.from === m.to)).toBe(true);
  });

  it("throws for a NAMED run whose record is corrupt on disk (never silently empty)", async () => {
    const root = await makeTempRoot("wf-adapt-named-corrupt");
    await installWorkflowProfile(root, buildWorkflowProfile(BUILD_STAGES));
    const run = await startWorkflow(root, "build", {});
    const leaf = path.join(root, ".llmwiki", "workflows", "runs", `${run.runId}.json`);
    await writeFile(leaf, "{ not json", "utf8");
    await expect(adaptDryRun(root, run.runId)).rejects.toBeInstanceOf(AdaptDryRunError);
  });
});
