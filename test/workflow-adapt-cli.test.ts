/**
 * @file test/workflow-adapt-cli.test.ts
 * @description Real-subprocess tests for `llmwiki workflow adapt` over `dist/cli.js`.
 *
 * Drives the real CLI: a `--dry-run` prints the plan and changes nothing; an
 * `--apply` of a LOSSLESS (renamed-stage) adaptation re-anchors the run; an
 * `--apply` of a LOSSY (stage-removed) adaptation WITHOUT `--confirm` exits
 * non-zero, lists the losses, and leaves the run unchanged; WITH `--confirm` it
 * applies.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCLI, startBuildRunCLI } from "./fixtures/run-cli.js";
import {
  installWorkflowProfile,
  buildWorkflowProfile,
  ADAPT_BUILD_STAGES as BUILD,
  ADAPT_RENAMED_STAGES as RENAMED,
  ADAPT_REMOVED_STAGES as REMOVED,
} from "./fixtures/workflow-profile.js";

let root = "";

/** Start a run in the current temp root and return its minted id. */
const startRun = (): Promise<string> => startBuildRunCLI(root);

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "workflow-adapt-cli-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("workflow adapt --dry-run / --apply lossless", () => {
  it("dry-run prints the plan and changes nothing; apply re-anchors", async () => {
    await installWorkflowProfile(root, buildWorkflowProfile(BUILD));
    const runId = await startRun();
    await installWorkflowProfile(root, buildWorkflowProfile(RENAMED));

    const dry = await runCLI(["workflow", "adapt", "--dry-run", runId], root);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toMatch(/draft.*compose/);
    const before = await runCLI(["workflow", "status", runId], root);
    expect(before.stdout).toMatch(/needs-adaptation/);

    const apply = await runCLI(["workflow", "adapt", "--apply", runId], root);
    expect(apply.code).toBe(0);
    const after = await runCLI(["workflow", "status", runId], root);
    expect(after.stdout).toMatch(/current/);
  });
});

describe("workflow adapt --apply lossy", () => {
  it("without --confirm exits non-zero, lists losses, leaves the run unchanged", async () => {
    await installWorkflowProfile(root, buildWorkflowProfile(BUILD));
    const runId = await startRun();
    await installWorkflowProfile(root, buildWorkflowProfile(REMOVED));

    const closed = await runCLI(["workflow", "adapt", "--apply", runId], root);
    expect(closed.code).not.toBe(0);
    expect(closed.stdout + closed.stderr).toMatch(/draft/);
    expect(closed.stdout + closed.stderr).toMatch(/--confirm/);
    const status = await runCLI(["workflow", "status", runId], root);
    expect(status.stdout).not.toMatch(/cancelled|historical/);
  });

  it("with --confirm applies the lossy adaptation", async () => {
    await installWorkflowProfile(root, buildWorkflowProfile(BUILD));
    const runId = await startRun();
    await installWorkflowProfile(root, buildWorkflowProfile(REMOVED));

    const applied = await runCLI(["workflow", "adapt", "--apply", runId, "--confirm"], root);
    expect(applied.code).toBe(0);
    const status = await runCLI(["workflow", "status", runId], root);
    expect(status.stdout).toMatch(/cancelled|historical/);
  });
});
