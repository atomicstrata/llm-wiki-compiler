/**
 * @file test/workflow-cli.test.ts
 * @description Real-subprocess tests for the `workflow` CLI group (list/start/status).
 *
 * Scaffolds a tmp project with a non-default profile declaring a `build`
 * workflow over two entity types, then drives `dist/cli.js` via `runCLI`:
 *  - `workflow list` names the workflow + its stage ids;
 *  - a default project's `workflow list` reports none declared;
 *  - `workflow start build` mints a run, writing `.llmwiki/workflows/runs/<id>.json`;
 *  - `workflow status` then shows that run as `current`;
 *  - an undeclared workflow start exits non-zero and writes no run;
 *  - `workflow status <bogus>` exits non-zero with a problem and writes nothing.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCLI } from "./fixtures/run-cli.js";
import { installWorkflowProfile } from "./fixtures/workflow-profile.js";

let root = "";

/** List the run-id stems persisted under `.llmwiki/workflows/runs/`, or [] if absent. */
async function listRunFiles(): Promise<string[]> {
  try {
    return await readdir(path.join(root, ".llmwiki", "workflows", "runs"));
  } catch {
    return [];
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("workflow list", () => {
  it("names the declared workflow and its stage ids", async () => {
    await installWorkflowProfile(root);
    const result = await runCLI(["workflow", "list"], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("build");
    expect(result.stdout).toMatch(/draft.*run|run.*draft|draft, run/);
  });

  it("reports none declared on a default project", async () => {
    const result = await runCLI(["workflow", "list"], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No workflows declared.");
  });
});

describe("workflow start / status", () => {
  it("starts a run, writes the run file, and shows it as current", async () => {
    await installWorkflowProfile(root);
    const start = await runCLI(["workflow", "start", "build"], root);
    expect(start.code).toBe(0);
    expect(start.stdout).toMatch(/build-/);
    expect(await listRunFiles()).toHaveLength(1);

    const status = await runCLI(["workflow", "status"], root);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("current");
  });

  it("exits non-zero and writes nothing for an undeclared workflow", async () => {
    await installWorkflowProfile(root);
    const result = await runCLI(["workflow", "start", "ghost"], root);
    expect(result.code).not.toBe(0);
    expect(await listRunFiles()).toHaveLength(0);
  });

  it("exits non-zero with a problem for a bogus run id, writing nothing", async () => {
    await installWorkflowProfile(root);
    const result = await runCLI(["workflow", "status", "build-2026-01-01-9999"], root);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/problem|unknown/i);
    expect(await listRunFiles()).toHaveLength(0);
  });
});
