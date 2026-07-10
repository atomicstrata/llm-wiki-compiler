/**
 * @file test/workflow-advance-artifact-stage.test.ts
 * @description Regression test for `advance`'s `outputRecorded` predicate on an
 * artifact-only stage (empty `writes`, non-empty `artifactWrites`). Such a stage is
 * NOT write-less per the {@link submitStageOutput} contract (`stage-output.ts`) — it
 * advances only once its artifact is submitted. `advance` must PARK it
 * `awaiting-output` rather than treat the empty `writes` array as trivially
 * satisfied and skip straight past it.
 */

import { describe, it, expect } from "vitest";
import { advanceWorkflow } from "../src/workflows/advance.js";
import { workflowStatus } from "../src/workflows/status.js";
import { researchArtifactProfile, startArtifactRun } from "./fixtures/artifact-seam-fixtures.js";

describe("advanceWorkflow — artifact-only stage", () => {
  it("parks awaiting-output instead of skipping an unsubmitted artifact-only stage", async () => {
    const { root, runId } = await startArtifactRun("wf-adv-artifact-", researchArtifactProfile());
    const result = await advanceWorkflow(root, runId);
    expect(result.outcome).toBe("awaiting-output");
    // Parked ON the artifact-only stage (not stepped past): still running, still on `run`.
    expect({ status: result.run.status, stage: result.run.currentStage }).toEqual({ status: "running", stage: "run" });
  });

  // Sibling-surface regression: `workflow status` must agree with `advance` on an
  // artifact-only park — it hints `--artifact-type`, NOT `--entity-type` (the stage
  // declares no `writes`, so there is no entity type to submit).
  it("status reports awaiting-output + an artifact-type submit hint (not entity-type) for a parked artifact-only stage", async () => {
    const { root, runId } = await startArtifactRun("wf-adv-artifact-status-", researchArtifactProfile());
    await advanceWorkflow(root, runId);
    const [status] = await workflowStatus(root, runId);
    expect({
      awaitingOutput: status.awaitingOutput,
      nextSubmitArtifactType: status.nextSubmitArtifactType,
      nextSubmitEntityType: status.nextSubmitEntityType,
    }).toEqual({ awaitingOutput: true, nextSubmitArtifactType: "experiment-result", nextSubmitEntityType: undefined });
  });
});
