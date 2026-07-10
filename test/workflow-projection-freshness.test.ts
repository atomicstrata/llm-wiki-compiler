/**
 * @file test/workflow-projection-freshness.test.ts
 * @description Tests for projection freshness (M5): the projection stamps the run's
 * stateVersion, an advance AUTO-projects (so a declared projectionFile reflects the
 * NEW currentStage, not stale), and a projection-write FAILURE does not fail the op.
 */

import { describe, it, expect } from "vitest";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { buildWorkflowProfile, installWorkflowProfile } from "./fixtures/workflow-profile.js";
import { startWorkflow } from "../src/workflows/start.js";
import { advanceWorkflow } from "../src/workflows/advance.js";
import type { ProfilePack, WorkflowStageDef } from "../src/profile/types.js";

const PROJECTION = "wiki/outputs/workflows/build.md";

/** A two-stage read-only `build` (advances on each call). */
const STAGES: WorkflowStageDef[] = [
  { id: "draft", reads: ["ideas"], writes: [] },
  { id: "run", reads: ["ideas"], writes: [] },
];

/** Install a `build` profile with a declared projectionFile. */
async function installProjected(root: string): Promise<void> {
  const pack: ProfilePack = buildWorkflowProfile(STAGES);
  pack.workflows!.build.projectionFile = PROJECTION;
  await installWorkflowProfile(root, pack);
}

describe("projection freshness", () => {
  it("auto-projects on advance: the projectionFile reflects the NEW currentStage and stamps stateVersion", async () => {
    const root = await makeTempRoot("wf-fresh-advance");
    await installProjected(root);
    const run = await startWorkflow(root, "build", {});
    const advanced = await advanceWorkflow(root, run.runId);
    const md = await readFile(path.join(root, PROJECTION), "utf8");
    expect(md).toContain(`currentStage: ${advanced.run.currentStage}`);
    expect(md).toContain(`stateVersion: ${advanced.run.stateVersion}`);
  });

  it("a projection-write failure does NOT fail the advance", async () => {
    const root = await makeTempRoot("wf-fresh-failure");
    await installProjected(root);
    const run = await startWorkflow(root, "build", {});
    // Plant a NON-projection authored file at the target so auto-project refuses
    // to clobber it (a fail-visible projection result) — the advance must still win.
    const target = path.join(root, PROJECTION);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "# authored, NOT a projection\n", "utf8");
    const advanced = await advanceWorkflow(root, run.runId);
    expect(advanced.outcome).toBe("advanced");
    expect(await readFile(target, "utf8")).toBe("# authored, NOT a projection\n");
  });
});

describe("projection freshness parity", () => {
  it("a workflow with NO projectionFile writes no projection on advance", async () => {
    const root = await makeTempRoot("wf-fresh-noproj");
    await installWorkflowProfile(root, buildWorkflowProfile(STAGES));
    const run = await startWorkflow(root, "build", {});
    await advanceWorkflow(root, run.runId);
    await expect(readFile(path.join(root, PROJECTION), "utf8")).rejects.toThrow();
  });
});
