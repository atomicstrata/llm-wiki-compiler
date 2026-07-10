/**
 * @file test/workflow-adapt-sdk.test.ts
 * @description Tests for the experimental adapt slice of the `Wiki` SDK facade:
 * `adaptDryRun` previews a renamed-stage run's plan without mutating it, and
 * `adaptWorkflowRun` re-anchors a lossless adaptation.
 */

import { describe, it, expect } from "vitest";
import { makeTempRoot } from "./fixtures/temp-root.js";
import {
  buildWorkflowProfile,
  installWorkflowProfile,
  ADAPT_BUILD_STAGES as BUILD,
  ADAPT_RENAMED_STAGES as RENAMED,
} from "./fixtures/workflow-profile.js";
import { createWiki } from "../src/sdk/wiki.js";
import { workflowDefDigest } from "../src/profile/workflow-digest.js";
import type { Wiki } from "../src/sdk/types.js";

/** Start a `build` run on the OLD def, then install the RENAMED def. Returns the facade + run id. */
async function startThenRename(prefix: string): Promise<{ wiki: Wiki; runId: string }> {
  const root = await makeTempRoot(prefix);
  await installWorkflowProfile(root, buildWorkflowProfile(BUILD));
  const wiki = createWiki({ root });
  const run = await wiki.startWorkflow("build", {});
  await installWorkflowProfile(root, buildWorkflowProfile(RENAMED));
  return { wiki, runId: run.runId };
}

describe("Wiki adapt facade", () => {
  it("adaptDryRun previews a renamed-stage run's plan", async () => {
    const { wiki, runId } = await startThenRename("wf-adapt-sdk-dry");
    const plans = await wiki.adaptDryRun(runId);
    expect(plans).toHaveLength(1);
    expect(plans[0].stageMapping).toContainEqual({ from: "draft", to: "compose" });
  });

  it("adaptWorkflowRun re-anchors a lossless adaptation", async () => {
    const { wiki, runId } = await startThenRename("wf-adapt-sdk-apply");
    const adapted = await wiki.adaptWorkflowRun(runId);
    expect(adapted.workflowDigest).toBe(workflowDefDigest({ stages: RENAMED }));
    expect(adapted.currentStage).toBe("compose");
  });
});
