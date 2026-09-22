/**
 * @file test/operation-cli-list-inspect.test.ts
 * @description Subprocess integration tests for the read-only `operation list`
 * and `operation inspect` CLI commands. Bundles are staged (and optionally driven)
 * in-process via the real engine seams, then the built CLI is spawned against the
 * same project root so the tests exercise the true operator entry point end to end.
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { runCLI, type CLIResult } from "./fixtures/run-cli.js";
import { approveAndApplyOperationBundleLocked } from "../src/operation-bundles/executor.js";
import { readOperationManifest } from "../src/operation-bundles/manifest-store.js";
import {
  approveRequest, buildRuntime, parkedSourceBundle, stageSourceBundle, WORKSPACE,
} from "./operation-bundles/executor-fixtures.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "op-cli-list-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** Approve-and-apply a freshly staged source bundle to the terminal succeeded state. */
async function stageSucceeded(): Promise<string> {
  const staged = await stageSourceBundle(root);
  await approveAndApplyOperationBundleLocked(root, approveRequest(staged, buildRuntime()));
  return staged.bundleId;
}

/** Run the CLI, assert a 0 exit, and assert every pattern against stdout. */
async function expectOkStdout(args: string[], ...patterns: RegExp[]): Promise<CLIResult> {
  const result = await runCLI(args, root);
  expect(result.code, result.stderr).toBe(0);
  for (const pattern of patterns) expect(result.stdout).toMatch(pattern);
  return result;
}

describe("operation list", () => {
  it("lists nothing and reports clean recovery for an empty project", async () => {
    await expectOkStdout(["operation", "list"], /No operation bundles/, /Recovery: clean/);
  });

  it("lists a staged bundle with its awaiting-approval state", async () => {
    const staged = await stageSourceBundle(root);
    const result = await expectOkStdout(["operation", "list"], /state=awaiting-approval/);
    expect(result.stdout).toContain(staged.bundleId);
  });

  it("emits recovery state and bundles as JSON", async () => {
    const staged = await stageSourceBundle(root);
    const result = await expectOkStdout(["operation", "list", "--json"]);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.recoveryState).toBe("clean");
    expect(parsed.bundles).toHaveLength(1);
    expect(parsed.bundles[0]).toMatchObject({ bundleId: staged.bundleId, state: "awaiting-approval" });
  });

  it("reports bundle-recovery-required for a parked run", async () => {
    await parkedSourceBundle(root);
    await expectOkStdout(["operation", "list"], /Recovery: bundle-recovery-required/);
  });
});

describe("operation inspect", () => {
  it("shows a succeeded run's state and counters by bundle id", async () => {
    const bundleId = await stageSucceeded();
    await expectOkStdout(["operation", "inspect", bundleId], /State: succeeded/, /Mutations: 1\/1 applied/);
  });

  it("resolves a target by run id", async () => {
    const staged = await stageSourceBundle(root);
    const read = await readOperationManifest(root, WORKSPACE, staged.bundleId);
    const runId = read.status === "ok" ? read.manifest.runId : "";
    const result = await expectOkStdout(["operation", "inspect", runId]);
    expect(result.stdout).toContain(runId);
  });

  it("emits the run envelope as JSON", async () => {
    const bundleId = await stageSucceeded();
    const result = await expectOkStdout(["operation", "inspect", bundleId, "--json"]);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.state).toBe("succeeded");
    expect(parsed.counters.mutations).toMatchObject({ attempted: 1, applied: 1 });
  });

  it("fails on an unknown target", async () => {
    const result = await runCLI(["operation", "inspect", "bnd_does-not-exist"], root);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/No operation bundle or run matches/);
  });
});
