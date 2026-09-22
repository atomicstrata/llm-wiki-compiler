/**
 * @file test/viewer-workflow-run-facts.test.ts
 * @description Projection controls for product-neutral verified fact panels and
 * fail-visible recorded-only reasons. Products supply text only; core enforces
 * closed tones, bounds, anchors, and verification-only placement.
 */

import { describe, expect, it } from "vitest";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { installWorkflowProfile, buildWorkflowProfile } from "./fixtures/workflow-profile.js";
import { startWorkflow } from "../src/workflows/start.js";
import {
  buildWorkflowRunProjection, type LiveStageProjectionProvider,
  type StageProjection, type WorkflowRunProjectionEnvelope,
} from "../src/viewer/workflow-run-projection.js";

const STAGES = [{ id: "draft", reads: ["ideas"], writes: [] }];

/** Create a one-stage run for a provider projection test. */
async function fixture(prefix: string): Promise<{ root: string; runId: string }> {
  const root = await makeTempRoot(prefix);
  await installWorkflowProfile(root, buildWorkflowProfile(STAGES));
  const run = await startWorkflow(root, "build", {});
  return { root, runId: run.runId };
}

/** Narrow a successful projection to its first stage. */
function firstStage(result: WorkflowRunProjectionEnvelope | { problem: string }): StageProjection {
  if ("problem" in result) throw new Error(result.problem);
  const stage = result.stages[0];
  if (stage === undefined) throw new Error("missing projected stage");
  return stage;
}

/** A run-bound provider result with caller-selected fields. */
function provider(fields: Record<string, unknown>): LiveStageProjectionProvider {
  return async (_root, workflowId, runId, expected) => ({
    workflowId, runId, ...expected, stages: [{
      stageId: "draft", summary: "Drafted the story.", appliedTargets: [], evidenceDigests: [],
      ...fields,
    }],
  });
}

describe("workflow-run generic facts and verification reasons", () => {
  it("admits a bounded verified fact panel with closed tones", async () => {
    const { root, runId } = await fixture("viewer-facts-valid");
    const stage = firstStage(await buildWorkflowRunProjection(root, "build", runId, provider({
      factPanel: { title: "Fact check", rows: [
        { label: "Coverage", value: "Complete", tone: "success" },
        { label: "Disputed", value: "0", tone: "neutral" },
      ] },
    })));
    expect(stage.verification).toBe("verified");
    if (stage.verification === "verified") expect(stage.factPanel?.rows).toHaveLength(2);
  });

  it("degrades a verified row whose fact panel uses an open-ended tone", async () => {
    const { root, runId } = await fixture("viewer-facts-tone");
    const stage = firstStage(await buildWorkflowRunProjection(root, "build", runId, provider({
      factPanel: { title: "Fact check", rows: [{ label: "Coverage", value: "Complete", tone: "sparkle" }] },
    })));
    expect(stage).toMatchObject({
      verification: "recorded-only",
      verificationReason: { category: "stale-or-invalid", code: "malformed-projection" },
    });
  });

  it("projects a provider-declared per-stage reason without fact-shaped fields", async () => {
    const { root, runId } = await fixture("viewer-facts-unavailable");
    const unavailable: LiveStageProjectionProvider = async (_r, workflowId, id, expected) => ({
      workflowId, runId: id, ...expected, stages: [],
      failures: [{ stageId: "draft", category: "unavailable", code: "evidence-missing" }],
    });
    expect(firstStage(await buildWorkflowRunProjection(root, "build", runId, unavailable))).toEqual(
      expect.objectContaining({
        verification: "recorded-only",
        verificationReason: { category: "unavailable", code: "evidence-missing" },
      }),
    );
  });

  it("distinguishes a local verification timeout from stale authority", async () => {
    const { root, runId } = await fixture("viewer-facts-timeout");
    const never: LiveStageProjectionProvider = () => new Promise(() => undefined);
    const stage = firstStage(await buildWorkflowRunProjection(root, "build", runId, never, 5));
    expect(stage).toMatchObject({
      verification: "recorded-only",
      verificationReason: { category: "timed-out", code: "verification-timeout" },
    });
  });
});
