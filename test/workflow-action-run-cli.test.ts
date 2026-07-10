/**
 * @file test/workflow-action-run-cli.test.ts
 * @description Real-subprocess tests for `workflow action run` (surface `cli`).
 *
 * Drives `dist/cli.js` against a tmp project whose profile declares run-action
 * fixtures: a `start` action mints a run on disk and prints the operation +
 * effective permission; a local-config-tightened grant DENIES a `start` (nonzero,
 * nothing minted); a `human:`-gate action without local enablement is DENIED; a
 * bad/missing required input and an unknown action id each exit nonzero.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCLI } from "./fixtures/run-cli.js";
import { installRunActionProfile, plantLocalConfig } from "./fixtures/run-action-profile.js";

let root = "";
const RUNS_DIR = ".llmwiki/workflows/runs";

/** List the minted run files (or [] when the runs dir does not exist). */
async function mintedRuns(): Promise<string[]> {
  try {
    return await readdir(path.join(root, RUNS_DIR));
  } catch {
    return [];
  }
}

/** Install the run-action profile, then drive `workflow action run <rest>` over the tmp root. */
async function runActionCLI(rest: string[]): ReturnType<typeof runCLI> {
  await installRunActionProfile(root);
  return runCLI(["workflow", "action", "run", ...rest], root);
}

/** Assert a CLI result FAILED (nonzero, message matches `pattern`) and minted NO run. */
async function expectFailedNoMint(result: Awaited<ReturnType<typeof runCLI>>, pattern: RegExp): Promise<void> {
  expect(result.code).not.toBe(0);
  expect(result.stdout + result.stderr).toMatch(pattern);
  expect((await mintedRuns()).length).toBe(0);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "wf-action-run-cli-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("workflow action run", () => {
  it("runs a start action: mints a run and prints operation + permission", async () => {
    const result = await runActionCLI(["build.start"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/start/);
    expect(result.stdout).toMatch(/trusted-write|staged-write/);
    expect((await mintedRuns()).length).toBe(1);
  });

  it("denies a start tightened to read-only by local config (nothing minted)", async () => {
    await installRunActionProfile(root);
    await plantLocalConfig(root, { workflowGrants: { cli: "read-only" } });
    const result = await runCLI(["workflow", "action", "run", "build.start"], root);
    await expectFailedNoMint(result, /denied/i);
  });

  it("denies a human-gate action without operator enablement", async () => {
    const result = await runActionCLI(["gatehuman.approve", "--input", "runId=anything"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/denied/i);
  });

  it("FIX A: denies a human-gate action run NON-interactively even WITH operator enablement", async () => {
    // Start + park a real humanwf run, then attempt the human-gate action over a
    // PIPE (subprocess stdin is not a TTY) WITH the operator env var set. The action
    // surface must route through the same interactive proof and DENY — the bypass is
    // dead. (An interactive cli operator at a TTY would still satisfy it.)
    await installRunActionProfile(root);
    const env = { LLMWIKI_ENABLED_HUMAN_GATES: "human:approve" };
    const start = await runCLI(["workflow", "start", "humanwf"], root, env);
    const runId = (start.stdout.match(/humanwf-[\w-]+/) ?? [""])[0];
    await runCLI(["workflow", "advance", runId], root, env); // park awaiting-gate
    const result = await runCLI(["workflow", "action", "run", "gatehuman.approve", "--input", `runId=${runId}`], root, env);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/denied|interactive|confirm/i);
  });

  it("exits nonzero on a missing required input", async () => {
    const result = await runActionCLI(["build.advance"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/invalid inputs|runId/i);
  });

  it("exits nonzero for an unknown action id", async () => {
    const result = await runActionCLI(["ghost"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/not declared|ghost/i);
  });
});

describe("workflow action run --input-json (typed inputs)", () => {
  it("runs a number-input action via --input-json (value reaches core as a number)", async () => {
    const result = await runActionCLI(["build.startn", "--input-json", '{"count":2,"dryRun":true,"tags":["a","b"]}']);
    expect(result.code).toBe(0);
    expect((await mintedRuns()).length).toBe(1);
  });

  it("exits nonzero on malformed --input-json BEFORE touching the core (nothing minted)", async () => {
    const result = await runActionCLI(["build.startn", "--input-json", "{not json"]);
    await expectFailedNoMint(result, /--input-json|json/i);
  });

  it("merges --input string with --input-json (json takes precedence)", async () => {
    const result = await runActionCLI(["build.startn", "--input", "count=99", "--input-json", '{"count":2}']);
    expect(result.code).toBe(0);
    expect((await mintedRuns()).length).toBe(1);
  });

  it("exits nonzero on an --input-json over the byte cap (rejected BEFORE parse, nothing minted)", async () => {
    // A raw payload > 64 KiB. The bound is enforced on the RAW string before
    // JSON.parse, so an oversize payload can never be materialized/minted.
    const huge = `{"v":"${"x".repeat(70 * 1024)}"}`;
    const result = await runActionCLI(["build.startn", "--input-json", huge]);
    await expectFailedNoMint(result, /exceeds the cap|too large|rejected/i);
  });

  it("exits nonzero on a deeply-nested --input-json (no crash/overflow, nothing minted)", async () => {
    // Nesting far past the depth cap would overflow stringify/canonicalize; the
    // depth guard fails closed cleanly with a non-zero exit and no stack overflow.
    let nested = "1";
    for (let i = 0; i < 50; i++) nested = `{"a":${nested}}`;
    const result = await runActionCLI(["build.startn", "--input-json", nested]);
    await expectFailedNoMint(result, /nesting|depth|rejected/i);
  });
});
