/**
 * @file test/products/product-parent-resume-e2e.test.ts
 * @description P6.2 E2E witness (plan v8 P1): a PARENT-BOUND product run driven
 * through the REAL product service — invoke → review gate → resume. It proves
 * the resume path threads the sealed plan's workflowParent so the recompiled
 * plan reproduces the parent-grafted planDigest (without the fix, resume refuses
 * "that action does not reproduce this run's sealed plan"), and that the
 * under-lock admission refuses a resume whose parent has advanced past this
 * stage or is no longer running. The bootstrap action is used because it
 * suspends at a review gate with minimal setup.
 */

import { onTestFinished, describe, expect, it } from "vitest";
import { preparationGateCommand } from "../../src/commands/preparation/gate.js";
import { writeRun } from "../../src/workflows/store.js";
import { WORKFLOW_RUN_SCHEMA_VERSION, type WorkflowRun, type WorkflowRunStatus } from "../../src/workflows/types.js";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { acquireMutationLockBlocking } from "../../src/operation-bundles/lock-gate.js";
import { releaseLock } from "../../src/utils/lock.js";
import { activatedProject, buildVerticalProduct, gatedVerticalPack, verticalService, VERTICAL_ACTION_ID, VERTICAL_WORKSPACE_ID } from "./product-vertical-fixture.js";

const PARENT_RUN_ID = "journey-2026-08-29-e2e";
const WF_DIGEST = "ab".repeat(32);
const STAGE = "ingest";

/** Write the parent journey run at a given status / current stage. */
async function writeParent(root: string, status: WorkflowRunStatus, currentStage: string | null): Promise<void> {
  const run: WorkflowRun = {
    schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION, runId: PARENT_RUN_ID, workflowId: "research-journey",
    workflowDigest: WF_DIGEST, profileDigest: "cd".repeat(32), knownStageIds: [STAGE, "ideate"],
    status, currentStage, stageLog: [{ stageId: STAGE, status: "running" }],
    inputs: {}, outputs: {}, stateVersion: 0, startedAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    events: [{ type: "workflow-start", at: "2026-08-29T00:00:00.000Z", actorKind: "system", stateVersionBefore: 0, stateVersionAfter: 0 }],
    satisfiedGates: [],
  };
  await writeRun(root, run);
}

const parentRef = { workflowRunId: PARENT_RUN_ID, workflowId: "research-journey", workflowDigest: parseSha256Digest(`sha256:${WF_DIGEST}`), stageId: STAGE };

/** Invoke the parent-bound bootstrap and clear its review gate; return root + runId. */
async function invokeParentBoundToGate() {
  const project = await activatedProject(buildVerticalProduct(gatedVerticalPack()));
  onTestFinished(() => project.cleanup());
  await writeParent(project.root, "running", STAGE);
  const invoked = await verticalService(project.root, ["preparation.run"]).invoke({
    workspaceId: VERTICAL_WORKSPACE_ID, token: VERTICAL_ACTION_ID, input: { topic: "parent resume" }, workflowParent: parentRef,
  });
  expect(invoked.status, JSON.stringify(invoked)).toBe("awaiting-review");
  if (invoked.status !== "awaiting-review") throw new Error("unreachable");
  expect(await preparationGateCommand(project.root, invoked.runId, "review", "approved", { json: true })).toBe(0);
  return { root: project.root, runId: invoked.runId };
}

const resume = (root: string, runId: string) =>
  verticalService(root, ["preparation.run"]).resume({ workspaceId: VERTICAL_WORKSPACE_ID, runId, token: VERTICAL_ACTION_ID });

/** Invoke+gate a parent-bound run, move the parent, and assert the resume refuses with `reason`. */
async function expectResumeRefused(move: readonly [WorkflowRunStatus, string | null], reason: string): Promise<void> {
  const { root, runId } = await invokeParentBoundToGate();
  await writeParent(root, move[0], move[1]);
  const resumed = await resume(root, runId);
  expect(resumed.status, JSON.stringify(resumed)).toBe("refused");
  if (resumed.status !== "refused") throw new Error("unreachable");
  expect(resumed.reason).toBe(reason);
}

describe("parent-bound product invoke -> gate -> resume", () => {
  it("resumes: the recompiled plan reproduces the sealed parent-grafted digest", async () => {
    const { root, runId } = await invokeParentBoundToGate();
    const resumed = await resume(root, runId);
    expect(resumed.status, JSON.stringify(resumed)).toBe("handed-off");
  }, 120_000);

  it("refuses the resume when the parent has advanced past this stage", async () => {
    await expectResumeRefused(["running", "ideate"], "workflow-parent-stage-not-current");
  }, 120_000);

  it("refuses the resume when the parent is no longer running", async () => {
    await expectResumeRefused(["completed", STAGE], "workflow-parent-not-running");
  }, 120_000);

  // The LOCK itself, not just the admission arms. The parent has ALREADY moved
  // past this stage; the test then HOLDS the shared mutation lock and fires
  // resume. WITH the under-lock admission, resume blocks on the held lock and
  // cannot even read the parent — it stays pending until release. WITHOUT the
  // lock, resume reads the already-moved parent and REFUSES with no lock at all,
  // resolving WHILE the test still holds it. So "resume must not resolve under
  // the held lock" reddens exactly when acquireMutationLockBlocking is removed
  // (the admission-arm tests above stay green either way).
  it("serializes the resume admission behind the mutation lock (contention)", async () => {
    const { root, runId } = await invokeParentBoundToGate();
    await writeParent(root, "running", "ideate"); // parent already moved on
    await acquireMutationLockBlocking(root, "ordinary");
    let settled = false;
    const resumeP = resume(root, runId).then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 1500)); // ample time for a lock-free refusal to resolve
    expect(settled, "resume must block on the held mutation lock, not resolve under it").toBe(false);
    await releaseLock(root);
    const resumed = await resumeP;
    expect(resumed.status, JSON.stringify(resumed)).toBe("refused");
    if (resumed.status !== "refused") throw new Error("unreachable");
    expect(resumed.reason).toBe("workflow-parent-stage-not-current");
  }, 120_000);
});
