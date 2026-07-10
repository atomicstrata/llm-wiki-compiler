/**
 * @file test/workflow-run-action-scope.test.ts
 * @description ADVERSARIAL workflow-SCOPE tests for `runAction`.
 *
 * The invariant under test: an action declares the workflow it operates on
 * (`def.workflow`), and a runId-bearing op (`resume`/`advance`/`cancel`/`gate`,
 * and `status` WHEN given a runId) may target ONLY a run whose stored
 * `workflowId` matches that declared workflow. A `build`-scoped action handed a
 * `secret` run's runId is REFUSED ({@link ActionRunWorkflowMismatchError}) BEFORE
 * any dispatch, and the cross-workflow target is left byte-unchanged on disk. An
 * absent/unavailable target fails CLOSED (no dispatch). A no-runId `status`
 * action is FILTERED to its own workflow's runs.
 */

import { describe, it, expect } from "vitest";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { installRunActionProfile } from "./fixtures/run-action-profile.js";
import { runAction } from "../src/workflows/run-action.js";
import { ActionRunWorkflowMismatchError, RunUnavailableError } from "../src/workflows/errors.js";
import { startWorkflow } from "../src/workflows/start.js";
import { readRun } from "../src/workflows/store.js";
import type { RunStatus } from "../src/workflows/status.js";
import type { WorkflowRun } from "../src/workflows/types.js";

/** Install the action profile under a fresh temp root. */
async function setup(prefix: string): Promise<string> {
  const root = await makeTempRoot(prefix);
  await installRunActionProfile(root);
  return root;
}

/** Re-read a persisted run, failing the test if it is not readable. */
async function loadRun(root: string, runId: string): Promise<WorkflowRun> {
  const read = await readRun(root, runId);
  if (read.status !== "ok") throw new Error(`run not ok: ${read.status}`);
  return read.run;
}

describe("runAction — cross-workflow scope (advance/cancel/gate)", () => {
  it("REFUSES a build.cancel targeting a secret run and leaves it UNCHANGED", async () => {
    const root = await setup("ra-scope-cancel");
    const secret = await startWorkflow(root, "secret", {});
    const before = await loadRun(root, secret.runId);
    await expect(runAction(root, "build.cancel", { runId: secret.runId }, "cli")).rejects.toBeInstanceOf(
      ActionRunWorkflowMismatchError,
    );
    const after = await loadRun(root, secret.runId);
    expect(after.status).toBe(before.status);
    expect(after.status).not.toBe("cancelled");
    expect(after.stateVersion).toBe(before.stateVersion);
  });

  it("REFUSES a build.advance targeting a secret run and leaves it UNCHANGED", async () => {
    const root = await setup("ra-scope-advance");
    const secret = await startWorkflow(root, "secret", {});
    const before = await loadRun(root, secret.runId);
    await expect(runAction(root, "build.advance", { runId: secret.runId }, "cli")).rejects.toBeInstanceOf(
      ActionRunWorkflowMismatchError,
    );
    expect((await loadRun(root, secret.runId)).stateVersion).toBe(before.stateVersion);
  });

  it("STILL works on a same-workflow (build) target", async () => {
    const root = await setup("ra-scope-same");
    const build = await startWorkflow(root, "build", {});
    await runAction(root, "build.cancel", { runId: build.runId }, "cli");
    expect((await loadRun(root, build.runId)).status).toBe("cancelled");
  });
});

describe("runAction — runId status is scope-checked, no-runId status is filtered", () => {
  it("REFUSES a build.statusone targeting a secret run", async () => {
    const root = await setup("ra-scope-status-id");
    const secret = await startWorkflow(root, "secret", {});
    await expect(runAction(root, "build.statusone", { runId: secret.runId }, "cli")).rejects.toBeInstanceOf(
      ActionRunWorkflowMismatchError,
    );
  });

  it("FILTERS a no-runId status to ONLY the action's workflow runs", async () => {
    const root = await setup("ra-scope-status-all");
    const build = await startWorkflow(root, "build", {});
    await startWorkflow(root, "secret", {});
    const result = await runAction(root, "build.status", {}, "cli");
    const runs = result.result as RunStatus[];
    expect(runs.map((r) => r.runId)).toEqual([build.runId]);
    expect(runs.every((r) => r.run?.workflowId === "build")).toBe(true);
  });
});

describe("runAction — absent/unavailable target fails closed", () => {
  it("THROWS RunUnavailableError for an absent runId and never dispatches", async () => {
    const root = await setup("ra-scope-absent");
    await expect(runAction(root, "build.cancel", { runId: "build-2026-01-01-deadbeef" }, "cli")).rejects.toBeInstanceOf(
      RunUnavailableError,
    );
  });
});
