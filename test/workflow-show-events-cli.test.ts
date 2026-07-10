/**
 * @file test/workflow-show-events-cli.test.ts
 * @description Real-subprocess tests for `workflow show` and `workflow events`.
 *
 * `workflow show build` lists each stage with its reads/writes; an unknown
 * workflow id exits non-zero. `workflow events <run>` shows the recorded events
 * (incl. the genesis `workflow-start`); an unknown run id exits non-zero.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCLI } from "./fixtures/run-cli.js";
import { installWorkflowProfile } from "./fixtures/workflow-profile.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "workflow-show-cli-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("workflow show", () => {
  it("lists the stages with reads/writes", async () => {
    await installWorkflowProfile(root);
    const result = await runCLI(["workflow", "show", "build"], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("draft");
    expect(result.stdout).toContain("run");
    expect(result.stdout).toContain("reads:");
    expect(result.stdout).toContain("writes:");
  });

  it("exits non-zero for an unknown workflow id", async () => {
    await installWorkflowProfile(root);
    const result = await runCLI(["workflow", "show", "ghost"], root);
    expect(result.code).not.toBe(0);
  });
});

describe("workflow events", () => {
  it("shows the recorded events including the genesis workflow-start", async () => {
    await installWorkflowProfile(root);
    const start = await runCLI(["workflow", "start", "build"], root);
    const runId = (start.stdout.match(/build-[a-z0-9-]+/) ?? [""])[0];
    const result = await runCLI(["workflow", "events", runId], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("workflow-start");
  });

  it("exits non-zero for an unknown run id", async () => {
    await installWorkflowProfile(root);
    const result = await runCLI(["workflow", "events", "build-2026-01-01-9999"], root);
    expect(result.code).not.toBe(0);
  });
});
