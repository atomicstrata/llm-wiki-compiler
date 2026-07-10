/**
 * @file test/research-workflow-projection-genericity.test.ts
 * @description Two proofs that the workflow machinery is profile-AGNOSTIC config,
 * not research-shaped: (1) a research run's projection renders through the real
 * CLI; (2) a deliberately dissimilar `newsroom` profile drives a `story-pipeline`
 * run through the SAME start/advance/submit harness with ZERO core edit (C1). If
 * the newsroom run needs any new src/ code, the abstraction has failed.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCLI } from "./fixtures/run-cli.js";
import { installNewsroomProfile } from "./fixtures/newsroom-profile.js";
import { installResearchProfile } from "./fixtures/research-profile.js";
import { startRun } from "./fixtures/research-workflow.js";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("newsroom profile — same harness, no core edit", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "wf-genericity-"));
    await installNewsroomProfile(root);
  });

  it("starts and advances a story-pipeline run", async () => {
    const runId = await startRun(root, "story-pipeline", {});
    const advanced = await runCLI(["workflow", "advance", runId], root);
    expect(advanced.code).toBe(0);
  });
});

describe("research profile — a run's projection renders", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "wf-genericity-research-"));
    await installResearchProfile(root);
  });

  it("writes the DERIVED projection markdown containing the run id", async () => {
    const runId = await startRun(root, "research", {});

    const project = await runCLI(["workflow", "project", runId], root);
    expect(project.code).toBe(0);

    const md = await readFile(path.join(root, "wiki/outputs/workflows/research-run.md"), "utf8");
    expect(md).toContain(runId);
  });
});
