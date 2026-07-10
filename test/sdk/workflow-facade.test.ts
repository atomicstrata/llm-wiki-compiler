/**
 * @file test/sdk/workflow-facade.test.ts
 * @description Tests the EXPERIMENTAL `createWiki()` workflow slice in-process.
 *
 * Over a project WITH a non-default profile declaring a `build` workflow:
 * `startWorkflow` mints a `pending` run, `workflowStatus` classifies it
 * `current`, and `listWorkflows` surfaces the declared workflow + its stages.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createWiki } from "../../src/sdk/wiki.js";
import { UnknownActionError } from "../../src/workflows/errors.js";
import { ACTION_PROFILE, installWorkflowProfile } from "../fixtures/workflow-profile.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "sdk-workflow-"));
  await installWorkflowProfile(root);
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("createWiki workflow slice (experimental)", () => {
  it("starts a run, reports it current, and lists the declared workflow", async () => {
    const wiki = createWiki({ root });

    const run = await wiki.startWorkflow("build", {});
    expect(run.status).toBe("pending");
    expect(run.currentStage).toBe("draft");

    const statuses = await wiki.workflowStatus();
    expect(statuses).toHaveLength(1);
    expect(statuses[0].runId).toBe(run.runId);
    expect(statuses[0].classification).toBe("current");

    const summaries = await wiki.listWorkflows();
    expect(summaries).toEqual([{ workflowId: "build", stageIds: ["draft", "run"] }]);
  });
});

describe("createWiki action discovery (experimental)", () => {
  it("lists declared actions and shows the effective permission per surface", async () => {
    await installWorkflowProfile(root, ACTION_PROFILE);
    const wiki = createWiki({ root });

    const actions = await wiki.listActions();
    expect(actions.map((a) => a.actionId)).toEqual(["build.start"]);

    const detail = await wiki.showAction("build.start");
    expect(detail.effectivePermissions.cli).toBe("trusted-write");
    expect(detail.effectivePermissions.mcp).toBe("staged-write");
    await expect(wiki.showAction("ghost")).rejects.toBeInstanceOf(UnknownActionError);
  });
});
