/**
 * @file test/fixtures/workflow-run-helpers.ts
 * @description Start-and-advance preambles shared by the workflow tests: start a
 * `build` run through the SDK facade or the engine, park it on its first stage,
 * and assert a re-advance parks again.
 *
 * Split from `workflow-profile.ts` so the tests that only need the profile data
 * (most CLI tests) do not load the workflow engine and the SDK facade, which is
 * most of the source tree. Bun loads every test file's import graph afresh.
 */

import { expect } from "bun:test";
import { createWiki } from "../../src/sdk/wiki.js";
import { startWorkflow } from "../../src/workflows/start.js";
import { advanceWorkflow } from "../../src/workflows/advance.js";
import { makeTempRoot } from "./temp-root.js";
import { buildWorkflowProfile, installWorkflowProfile } from "./workflow-profile.js";
import type { WorkflowStageDef } from "../../src/profile/types.js";
import type { Wiki } from "../../src/sdk/types.js";

/**
 * Build an SDK facade over `root` and start a `build` run, returning both. Shared
 * by the SDK workflow tests so the create-facade + start-run preamble isn't
 * duplicated per file.
 *
 * @param root - The temp project root the facade binds to.
 * @returns The `Wiki` facade and the started run's id.
 */
export async function startBuildRun(root: string): Promise<{ wiki: Wiki; runId: string }> {
  const wiki = createWiki({ root });
  const run = await wiki.startWorkflow("build", {});
  return { wiki, runId: run.runId };
}

/**
 * Mint a fresh temp root, install a SINGLE-stage `build` workflow with `stage`, and
 * start a run — the `makeTempRoot → install → startWorkflow` preamble the
 * single-stage seam/lifecycle tests share. Grants are the caller's concern (set the
 * trusted-write env var before calling for an auto-applying stage).
 *
 * @param prefix - The mkdtemp prefix for the per-test root.
 * @param stage - The single `build` stage to install.
 * @returns The temp root and the started run's id.
 */
export async function startOneStageBuild(prefix: string, stage: WorkflowStageDef): Promise<{ root: string; runId: string }> {
  const root = await makeTempRoot(prefix);
  await installWorkflowProfile(root, buildWorkflowProfile([stage]));
  const run = await startWorkflow(root, "build", {});
  return { root, runId: run.runId };
}

/**
 * Mint a fresh temp root, install a `build` workflow with `stages`, start a run, and
 * advance once to PARK it on its first stage (awaiting-gate or awaiting-output). The
 * shared start-then-advance-to-park preamble several CLI/status tests use.
 *
 * @param prefix - The mkdtemp prefix for the per-test root.
 * @param stages - The `build` workflow stages to install.
 * @returns The temp root and the parked run's id.
 */
export async function startAndParkBuild(prefix: string, stages: WorkflowStageDef[]): Promise<{ root: string; runId: string }> {
  const root = await makeTempRoot(prefix);
  await installWorkflowProfile(root, buildWorkflowProfile(stages));
  const run = await startWorkflow(root, "build", {});
  await advanceWorkflow(root, run.runId);
  return { root, runId: run.runId };
}

/**
 * Advance `runId` once and assert it did NOT complete — it re-parked on the single
 * `run` stage. The shared post-condition the resume-retry tests use to prove a
 * cleared stage must be re-executed (the write re-submitted / the gate re-obtained)
 * rather than auto-completing off stale state.
 *
 * @param root - The project root.
 * @param runId - The run id to advance and assert on.
 */
export async function expectAdvanceParkedOnRun(root: string, runId: string): Promise<void> {
  const advanced = await advanceWorkflow(root, runId);
  expect(advanced.outcome).not.toBe("completed");
  expect(advanced.run.currentStage).toBe("run");
}
