/**
 * @file test/workflow-adapt-apply.test.ts
 * @description Behavioural tests for the under-lock `adaptApply` — re-anchoring an
 * in-flight run to a CHANGED workflow definition.
 *
 * Covers: a LOSSLESS adapt (a stage renamed via `previousIds`) re-anchors the run
 * (new digest, remapped current stage + stage log, `workflow-adapted` event with
 * `decision:"lossless"`) and the result classifies `current`; a LOSSY adapt (a
 * stage removed, the run sitting on it) fails CLOSED without `confirm`
 * ({@link AdaptationRequiresConfirmError}, run byte-unchanged) and applies WITH
 * `confirm` (the run is cancelled, the dropped id recorded on a `decision:"lossy"`
 * event); an already-current run is a no-op ({@link AlreadyCurrentError}); and a
 * run whose workflow was removed is a typed error.
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import {
  buildWorkflowProfile,
  installWorkflowProfile,
  ADAPT_BUILD_STAGES as BUILD,
  ADAPT_RENAMED_STAGES as RENAMED,
  ADAPT_REMOVED_STAGES as REMOVED,
} from "./fixtures/workflow-profile.js";
import { startWorkflow } from "../src/workflows/start.js";
import { adaptApply } from "../src/workflows/adapt.js";
import { cancelWorkflow } from "../src/workflows/cancel.js";
import { AdaptationRequiresConfirmError, AlreadyCurrentError, RunNotActiveError } from "../src/workflows/errors.js";
import { UnknownWorkflowError } from "../src/workflows/start.js";
import { workflowStatus } from "../src/workflows/status.js";
import { workflowDefDigest } from "../src/profile/workflow-digest.js";
import { readRun } from "../src/workflows/store.js";

/** Read the persisted run record (throws unless ok). */
async function readOk(root: string, runId: string) {
  const read = await readRun(root, runId);
  if (read.status !== "ok") throw new Error(`run not ok: ${read.status}`);
  return read.run;
}

describe("adaptApply — lossless", () => {
  it("re-anchors a renamed-stage run and the result classifies current", async () => {
    const root = await makeTempRoot("wf-apply-lossless");
    await installWorkflowProfile(root, buildWorkflowProfile(BUILD));
    const runId = (await startWorkflow(root, "build", {})).runId;
    await installWorkflowProfile(root, buildWorkflowProfile(RENAMED));

    const run = await adaptApply(root, runId);
    expect(run.workflowDigest).toBe(workflowDefDigest({ stages: RENAMED }));
    expect(run.currentStage).toBe("compose");
    expect(run.stageLog.map((e) => e.stageId)).toEqual(["compose", "run"]);
    expect(run.knownStageIds).toEqual(["compose", "run"]);
    expect(run.events.at(-1)).toMatchObject({ type: "workflow-adapted", decision: "lossless" });

    const [status] = await workflowStatus(root, runId);
    expect(status.classification).toBe("current");
  });
});

describe("adaptApply — lossy fail-closed", () => {
  it("throws AdaptationRequiresConfirmError without confirm and leaves the run byte-unchanged", async () => {
    const root = await makeTempRoot("wf-apply-lossy-closed");
    await installWorkflowProfile(root, buildWorkflowProfile(BUILD));
    const runId = (await startWorkflow(root, "build", {})).runId;
    const leaf = path.join(root, ".llmwiki", "workflows", "runs", `${runId}.json`);
    const before = await readFile(leaf, "utf8");
    await installWorkflowProfile(root, buildWorkflowProfile(REMOVED));

    await expect(adaptApply(root, runId)).rejects.toBeInstanceOf(AdaptationRequiresConfirmError);
    expect(await readFile(leaf, "utf8")).toBe(before);
  });

  it("applies a confirmed lossy adapt (cancels the run, records the dropped id)", async () => {
    const root = await makeTempRoot("wf-apply-lossy-confirm");
    await installWorkflowProfile(root, buildWorkflowProfile(BUILD));
    const runId = (await startWorkflow(root, "build", {})).runId;
    await installWorkflowProfile(root, buildWorkflowProfile(REMOVED));

    const run = await adaptApply(root, runId, { confirm: true });
    expect(run.status).toBe("cancelled");
    expect(run.currentStage).toBeNull();
    expect(run.workflowDigest).toBe(workflowDefDigest({ stages: REMOVED }));
    expect(run.stageLog.map((e) => e.stageId)).toEqual(["run"]);
    const event = run.events.at(-1);
    expect(event).toMatchObject({ type: "workflow-adapted", decision: "lossy" });
    expect(event?.detail).toContain("draft");
  });
});

describe("adaptApply — no-op and missing-workflow guards", () => {
  it("throws AlreadyCurrentError when the run already matches the active def", async () => {
    const root = await makeTempRoot("wf-apply-current");
    await installWorkflowProfile(root, buildWorkflowProfile(BUILD));
    const runId = (await startWorkflow(root, "build", {})).runId;
    const before = await readOk(root, runId);
    await expect(adaptApply(root, runId)).rejects.toBeInstanceOf(AlreadyCurrentError);
    expect((await readOk(root, runId)).stateVersion).toBe(before.stateVersion);
  });

  it("throws a typed error when the run's workflow was removed from the profile", async () => {
    const root = await makeTempRoot("wf-apply-removed-wf");
    await installWorkflowProfile(root, buildWorkflowProfile(BUILD));
    const runId = (await startWorkflow(root, "build", {})).runId;
    await installWorkflowProfile(root, { schemaVersion: 1, profileId: "research", entities: { ideas: { directory: "wiki/ideas" } }, workflows: {} });
    await expect(adaptApply(root, runId)).rejects.toBeInstanceOf(UnknownWorkflowError);
  });
});

describe("adaptApply — terminal guard (FIX 2)", () => {
  it("refuses to adapt a cancelled run and leaves it byte-unchanged", async () => {
    const root = await makeTempRoot("wf-apply-terminal");
    await installWorkflowProfile(root, buildWorkflowProfile(BUILD));
    const runId = (await startWorkflow(root, "build", {})).runId;
    await cancelWorkflow(root, runId);
    const leaf = path.join(root, ".llmwiki", "workflows", "runs", `${runId}.json`);
    const before = await readFile(leaf, "utf8");
    await installWorkflowProfile(root, buildWorkflowProfile(RENAMED));

    await expect(adaptApply(root, runId)).rejects.toBeInstanceOf(RunNotActiveError);
    expect(await readFile(leaf, "utf8")).toBe(before);
  });
});
