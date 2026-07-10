/**
 * @file test/workflow-adapt-pending.test.ts
 * @description Regression tests for the crash-marker (`pendingOutput`) remap on
 * adapt.
 *
 * `pendingOutput` is the applied-once INTENT marker a submit persists BEFORE its
 * external write, and the idempotency gate compares `pendingOutput.stageId ===
 * stage.id` exactly. So a lossless rename adapt (`draft`→`compose`) MUST remap
 * `pendingOutput.stageId` too — otherwise, after a crash mid-apply, the renamed
 * stage's gate reads the OLD id, no longer matches, and the already-landed
 * external write can be RE-APPLIED (a duplicate relation / lifecycle re-transition
 * / page overwrite). And a pending marker at a to-be-REMOVED stage must make the
 * plan LOSSY (require confirm), never silently drop the crash guard.
 */

import { describe, it, expect } from "vitest";
import {
  ADAPT_BUILD_STAGES as BUILD,
  ADAPT_RENAMED_STAGES as RENAMED,
  ADAPT_REMOVED_STAGES as REMOVED,
  buildWorkflowProfile,
  installWorkflowProfile,
  readOkRun,
} from "./fixtures/workflow-profile.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { startWorkflow } from "../src/workflows/start.js";
import { adaptApply } from "../src/workflows/adapt.js";
import { AdaptationRequiresConfirmError } from "../src/workflows/errors.js";
import { writeRun } from "../src/workflows/store.js";
import type { PendingStageOutput } from "../src/workflows/types.js";

/**
 * Stamp a crash marker (and optionally a divergent currentStage) onto the run.
 * When a currentStage override is given, the stageLog is cleared so the ONLY
 * reference to the marker's stage is `pendingOutput` — isolating its contribution.
 */
async function stampPending(root: string, runId: string, pendingOutput: PendingStageOutput, currentStage?: string): Promise<void> {
  const run = await readOkRun(root, runId);
  await writeRun(root, { ...run, pendingOutput, ...(currentStage ? { currentStage, stageLog: [] } : {}) });
}

describe("adaptApply — pendingOutput crash-marker remap", () => {
  it("remaps pendingOutput.stageId draft→compose so the applied-once gate stays armed", async () => {
    const root = await makeTempRoot("wf-adapt-pending");
    await installWorkflowProfile(root, buildWorkflowProfile(BUILD));
    const runId = (await startWorkflow(root, "build", {})).runId;
    await stampPending(root, runId, { stageId: "draft", opId: "op-x" });
    await installWorkflowProfile(root, buildWorkflowProfile(RENAMED));

    const adapted = await adaptApply(root, runId);
    expect(adapted.pendingOutput).toEqual({ stageId: "compose", opId: "op-x" });
  });

  it("a pending marker at a REMOVED stage forces a lossy plan (requires confirm)", async () => {
    const root = await makeTempRoot("wf-adapt-pending-removed");
    await installWorkflowProfile(root, buildWorkflowProfile(BUILD));
    const runId = (await startWorkflow(root, "build", {})).runId;
    // currentStage maps cleanly to `run`; only the crash marker points at the removed stage.
    await stampPending(root, runId, { stageId: "draft", opId: "op-x" }, "run");
    await installWorkflowProfile(root, buildWorkflowProfile(REMOVED));

    await expect(adaptApply(root, runId)).rejects.toBeInstanceOf(AdaptationRequiresConfirmError);
  });
});
