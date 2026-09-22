/**
 * @file test/operation-cli-drive.test.ts
 * @description Subprocess integration tests for the recovery-drive CLI commands
 * `operation resume`, `operation compensate`, and `operation cancel`. Runs are
 * staged/driven into the target state in-process via the real engine seams, then
 * the built CLI is spawned against the same root.
 *
 * PRODUCTION AUTHORITY: the CLI now builds the real operations-authority resolver.
 * These fixtures stage/park runs through the domain-neutral FIXTURE authority, so
 * the digest recorded at approval differs from the one the real resolver recomputes
 * at drive time — resume therefore parks `approval-invalidated` (genuine drift), and
 * compensate still parks without reverting. The run stays parked, a problem is
 * reported, and the exit code is non-zero — the correct fail-closed operator behavior.
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { runCLI, type CLIResult } from "./fixtures/run-cli.js";
import { approveAndApplyOperationBundleLocked } from "../src/operation-bundles/executor.js";
import { approveRequest, buildRuntime, parkedSourceBundle, stageSourceBundle } from "./operation-bundles/executor-fixtures.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "op-cli-drive-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** Assert a non-zero exit whose JSON envelope reports the expected state and problem code. */
function expectRefusal(result: CLIResult, state: string, code: string): void {
  expect(result.code, result.stderr).not.toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.state).toBe(state);
  expect(parsed.problems.map((problem: { code: string }) => problem.code)).toContain(code);
}

describe("operation cancel", () => {
  it("writes a created advisory for an active (parked) run", async () => {
    const staged = await parkedSourceBundle(root);
    const result = await runCLI(["operation", "cancel", staged.bundleId], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Cancel advisory created/);
  });

  it("reports exists on a repeated request", async () => {
    const staged = await parkedSourceBundle(root);
    await runCLI(["operation", "cancel", staged.bundleId], root);
    const again = await runCLI(["operation", "cancel", staged.bundleId], root);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/Cancel advisory exists/);
  });

  it("refuses a terminal run", async () => {
    const staged = await stageSourceBundle(root);
    await approveAndApplyOperationBundleLocked(root, approveRequest(staged, buildRuntime()));
    const result = await runCLI(["operation", "cancel", staged.bundleId], root);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/succeeded; a cancel advisory cannot take effect/);
  });

  it("fails on an unknown target", async () => {
    const result = await runCLI(["operation", "cancel", "bnd_missing"], root);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/No operation bundle or run matches/);
  });
});

describe("operation resume", () => {
  it("parks a fixture-staged run as approval-invalidated (drift under the real resolver)", async () => {
    const staged = await parkedSourceBundle(root);
    const result = await runCLI(["operation", "resume", staged.bundleId, "--json"], root);
    expectRefusal(result, "recovery-required", "approval-invalidated");
  });

  it("reports a no-op for a non-parked run", async () => {
    const staged = await stageSourceBundle(root);
    const result = await runCLI(["operation", "resume", staged.bundleId, "--json"], root);
    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.stdout).state).toBe("awaiting-approval");
  });

  it("fails on an unknown target", async () => {
    const result = await runCLI(["operation", "resume", "bnd_missing"], root);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/No operation bundle or run matches/);
  });
});

describe("operation compensate", () => {
  it("parks without reverting a parked run under Milestone-A authority", async () => {
    const staged = await parkedSourceBundle(root);
    const result = await runCLI(["operation", "compensate", staged.bundleId, "--json"], root);
    expectRefusal(result, "recovery-required", "bundle-recovery-required");
  });
});
