/**
 * @file test/workflow-adapt-outputs.test.ts
 * @description Regression tests for the lossless-adapt OUTPUTS-key remap.
 *
 * Stage outputs are keyed by STAGE ID (`run.outputs[stage.id]`), and `advance`
 * gates a write-declaring stage on `run.outputs[stage.id]` being present. So a
 * lossless rename adapt (`draft`→`compose` via `previousIds`) MUST remap the
 * recorded `outputs` keys too — otherwise the run ends on `compose` with the
 * output still under `draft`, and the next `advance` re-parks `awaiting-output`
 * and can RE-SUBMIT a live write. Also covers the fail-closed key collision: two
 * old keys mapping to the same new key is ambiguous and must throw.
 */

import { describe, it, expect } from "vitest";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { buildWorkflowProfile, installWorkflowProfile } from "./fixtures/workflow-profile.js";
import { startWorkflow } from "../src/workflows/start.js";
import { adaptApply, AdaptationKeyCollisionError } from "../src/workflows/adapt.js";
import { advanceWorkflow } from "../src/workflows/advance.js";
import { readRun, writeRun } from "../src/workflows/store.js";
import type { WorkflowStageDef } from "../src/profile/types.js";
import type { WorkflowRun } from "../src/workflows/types.js";

/** A write-declaring `build` whose first stage `draft` writes `ideas`. */
const BUILD: WorkflowStageDef[] = [
  { id: "draft", reads: ["ideas"], writes: ["ideas"] },
  { id: "run", reads: ["ideas"], writes: [] },
];

/** The `build` def renaming `draft`→`compose` via previousIds (writes preserved). */
const RENAMED: WorkflowStageDef[] = [
  { id: "compose", reads: ["ideas"], writes: ["ideas"], previousIds: ["draft"] },
  { id: "run", reads: ["ideas"], writes: [] },
];

/** Read the persisted run (throws unless ok). */
async function readOk(root: string, runId: string): Promise<WorkflowRun> {
  const read = await readRun(root, runId);
  if (read.status !== "ok") throw new Error(`run not ok: ${read.status}`);
  return read.run;
}

/** Persist `outputs` onto the run (simulating a recorded stage output). */
async function recordOutputs(root: string, runId: string, outputs: Record<string, unknown>): Promise<void> {
  const run = await readOk(root, runId);
  await writeRun(root, { ...run, outputs });
}

describe("adaptApply — outputs-key remap (lossless rename)", () => {
  it("remaps outputs.draft → outputs.compose so advance does not re-park awaiting-output", async () => {
    const root = await makeTempRoot("wf-adapt-outputs");
    await installWorkflowProfile(root, buildWorkflowProfile(BUILD));
    const runId = (await startWorkflow(root, "build", {})).runId;
    await recordOutputs(root, runId, { draft: { entityType: "ideas", slug: "x" } });
    await installWorkflowProfile(root, buildWorkflowProfile(RENAMED));

    const adapted = await adaptApply(root, runId);
    expect(adapted.currentStage).toBe("compose");
    expect(Object.hasOwn(adapted.outputs, "compose")).toBe(true);
    expect(Object.hasOwn(adapted.outputs, "draft")).toBe(false);

    const { outcome } = await advanceWorkflow(root, runId);
    expect(outcome).not.toBe("awaiting-output");
  });

  it("fails closed when two output keys collide on the same new id", async () => {
    const root = await makeTempRoot("wf-adapt-outputs-collide");
    await installWorkflowProfile(root, buildWorkflowProfile(BUILD));
    const runId = (await startWorkflow(root, "build", {})).runId;
    await recordOutputs(root, runId, { draft: { a: 1 }, compose: { b: 2 } });
    await installWorkflowProfile(root, buildWorkflowProfile(RENAMED));

    await expect(adaptApply(root, runId, { confirm: true })).rejects.toBeInstanceOf(AdaptationKeyCollisionError);
  });
});
