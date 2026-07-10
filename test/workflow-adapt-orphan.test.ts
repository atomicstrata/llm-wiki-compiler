/**
 * @file test/workflow-adapt-orphan.test.ts
 * @description Tests for lossy-adapt orphan reporting (M7).
 *
 * When a lossy adapt DROPS an `outputs[stageId]` whose value is a wiki page ref,
 * that page is ORPHANED (the run no longer references it). The plan surfaces it in
 * `orphanedOutputs`, the unconfirmed-confirm error carries it (so the CLI can show
 * the impact inline), and a CONFIRMED lossy adapt RECORDS the orphaned ref in the
 * `workflow-adapted` event detail — reported, not silently left.
 */

import { describe, it, expect } from "vitest";
import { makeTempRoot } from "./fixtures/temp-root.js";
import {
  buildWorkflowProfile,
  installWorkflowProfile,
  readOkRun,
  ADAPT_BUILD_STAGES,
  ADAPT_REMOVED_STAGES,
} from "./fixtures/workflow-profile.js";
import { startWorkflow } from "../src/workflows/start.js";
import { adaptApply, computeAdaptationPlan } from "../src/workflows/adapt.js";
import { AdaptationRequiresConfirmError } from "../src/workflows/errors.js";
import { writeRun } from "../src/workflows/store.js";

/**
 * Start a `draft`+`run` build, record a page output under `draft`, then switch the
 * profile to one that REMOVED `draft` (so `draft` + its output are unmappable).
 */
async function setupOrphan(prefix: string): Promise<{ root: string; runId: string }> {
  const root = await makeTempRoot(prefix);
  await installWorkflowProfile(root, buildWorkflowProfile(ADAPT_BUILD_STAGES));
  const runId = (await startWorkflow(root, "build", {})).runId;
  const run = await readOkRun(root, runId);
  // Park the run on `run` with a recorded page output keyed by the to-be-removed `draft`.
  await writeRun(root, { ...run, currentStage: "run", outputs: { draft: { entityType: "experiments", slug: "alpha" } } });
  await installWorkflowProfile(root, buildWorkflowProfile(ADAPT_REMOVED_STAGES));
  return { root, runId };
}

describe("lossy adapt orphan reporting", () => {
  it("computes orphanedOutputs for a dropped page output", async () => {
    const { root, runId } = await setupOrphan("wf-orphan-plan");
    const run = await readOkRun(root, runId);
    const plan = computeAdaptationPlan(run, buildWorkflowProfile(ADAPT_REMOVED_STAGES).workflows!.build);
    expect(plan.unmappable).toContain("draft");
    expect(plan.orphanedOutputs).toEqual(["experiments/alpha"]);
  });

  it("an unconfirmed lossy adapt carries the orphaned refs on the confirm error", async () => {
    const { root, runId } = await setupOrphan("wf-orphan-confirm");
    await expect(adaptApply(root, runId)).rejects.toMatchObject({
      orphanedOutputs: ["experiments/alpha"],
    });
    await expect(adaptApply(root, runId)).rejects.toBeInstanceOf(AdaptationRequiresConfirmError);
  });

  it("a confirmed lossy adapt records the orphaned ref in the workflow-adapted event detail", async () => {
    const { root, runId } = await setupOrphan("wf-orphan-record");
    const adapted = await adaptApply(root, runId, { confirm: true });
    const event = adapted.events.find((e) => e.type === "workflow-adapted");
    expect(event?.detail).toContain("orphaned: experiments/alpha");
  });
});
