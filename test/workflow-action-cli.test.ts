/**
 * @file test/workflow-action-cli.test.ts
 * @description Real-subprocess tests for the `workflow action` CLI group.
 *
 * Drives `dist/cli.js` against a tmp project whose profile declares one workflow
 * action (`build.start`, requesting `trusted-write` on every surface):
 *  - `workflow action list` names the declared action;
 *  - a default project reports "No workflow actions declared.";
 *  - `workflow action show build.start` prints the effective permission per
 *    surface (the `mcp` request clamps to `staged-write`);
 *  - an unknown action id exits non-zero.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCLI } from "./fixtures/run-cli.js";
import { ACTION_PROFILE, installWorkflowProfile } from "./fixtures/workflow-profile.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "wf-action-cli-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("workflow action list", () => {
  it("names the declared action", async () => {
    await installWorkflowProfile(root, ACTION_PROFILE);
    const result = await runCLI(["workflow", "action", "list"], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("build.start");
  });

  it("reports none declared on a default project", async () => {
    const result = await runCLI(["workflow", "action", "list"], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No workflow actions declared.");
  });
});

describe("workflow action show", () => {
  it("prints the effective permission per surface (mcp clamped to staged-write)", async () => {
    await installWorkflowProfile(root, ACTION_PROFILE);
    const result = await runCLI(["workflow", "action", "show", "build.start"], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/cli:\s*trusted-write[\s\S]*mcp:\s*staged-write/);
  });

  it("exits non-zero for an unknown action id", async () => {
    await installWorkflowProfile(root, ACTION_PROFILE);
    const result = await runCLI(["workflow", "action", "show", "ghost"], root);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/not declared|ghost/i);
  });
});
