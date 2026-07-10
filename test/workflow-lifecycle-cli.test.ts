/**
 * @file test/workflow-lifecycle-cli.test.ts
 * @description Real-subprocess tests for the workflow lifecycle CLI subcommands
 * (`advance`, `gate approve`, `cancel`, `resume`) over `dist/cli.js`.
 *
 * Scaffolds a tmp project with a non-default `build` workflow and drives the real CLI:
 *  - an AGENT-gated stage: start → advance → park `awaiting-gate` → `gate approve`
 *    (default agent actor, NON-interactive) → advance → `completed` (agent gates do
 *    not need a TTY);
 *  - C1 regression: a HUMAN-gated stage approved in a NON-interactive subprocess
 *    (stdin not a TTY — the agent-piping-the-CLI case) FAILS non-zero and satisfies
 *    NOTHING, no matter the `--actor` flag (the self-asserted human gate is dead);
 *  - `gate approve --actor agent` on a human gate fails non-zero and satisfies nothing;
 *  - `advance` onto a write-declaring stage parks `awaiting-output` (exit 0);
 *  - `cancel` mid-run leaves the run `cancelled`;
 *  - a bogus run id to advance/cancel/gate approve exits non-zero.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCLI, startBuildRunCLI } from "./fixtures/run-cli.js";
import { installWorkflowProfile, buildWorkflowProfile } from "./fixtures/workflow-profile.js";

let root = "";

/** Install a `build` workflow: stage 1 ungated read-only, stage 2 human-gated read-only. */
async function installGatedProfile(): Promise<void> {
  await installWorkflowProfile(
    root,
    buildWorkflowProfile([
      { id: "draft", reads: ["ideas"], writes: [] },
      { id: "review", reads: ["ideas"], writes: [], gate: "human:lead" },
    ]),
  );
}

/** Install a `build` workflow: stage 1 ungated, stage 2 AGENT-gated (no TTY needed). */
async function installAgentGatedProfile(): Promise<void> {
  await installWorkflowProfile(
    root,
    buildWorkflowProfile([
      { id: "draft", reads: ["ideas"], writes: [] },
      { id: "review", reads: ["ideas"], writes: [], gate: "agent:check" },
    ]),
  );
}

/** Start a run in the current temp root and return its minted run id (e.g. `build-...`). */
const startRun = (): Promise<string> => startBuildRunCLI(root);

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "workflow-lifecycle-cli-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("workflow advance / agent gate approve happy path (non-interactive)", () => {
  it("advances to an AGENT gate, approves it non-interactively, then completes", async () => {
    await installAgentGatedProfile();
    const runId = await startRun();

    const past1 = await runCLI(["workflow", "advance", runId], root);
    expect(past1.code).toBe(0);

    const parked = await runCLI(["workflow", "advance", runId], root);
    expect(parked.code).toBe(0);
    expect(parked.stdout).toMatch(/awaiting-gate/);

    // Agent gates do NOT need a TTY: the default agent actor approves over a pipe.
    const approve = await runCLI(["workflow", "gate", "approve", runId, "check"], root);
    expect(approve.code).toBe(0);

    const done = await runCLI(["workflow", "advance", runId], root);
    expect(done.code).toBe(0);
    expect(done.stdout).toMatch(/completed/);
  });
});

describe("C1: a HUMAN gate cannot be satisfied by a non-interactive subprocess", () => {
  /** Advance a fresh run onto the human gate and return its run id. */
  async function startAndParkHumanGate(): Promise<string> {
    await installGatedProfile();
    const runId = await startRun();
    await runCLI(["workflow", "advance", runId], root);
    await runCLI(["workflow", "advance", runId], root);
    return runId;
  }

  it("FAILS non-zero and satisfies nothing when an agent pipes the CLI (stdin not a TTY)", async () => {
    const runId = await startAndParkHumanGate();
    // The subprocess stdin/stdout are pipes (not a TTY) — the realistic agent case.
    const piped = await runCLI(["workflow", "gate", "approve", runId, "lead"], root);
    expect(piped.code).not.toBe(0);
    expect(piped.stdout + piped.stderr).toMatch(/interactive|terminal|not.*confirmed/i);
    // The gate is NOT satisfied: status still shows the awaiting gate.
    const status = await runCLI(["workflow", "status", runId], root);
    expect(status.stdout).toMatch(/lead/);
  });

  it("FAILS non-zero even with --actor human (the self-asserted human flag is dead)", async () => {
    const runId = await startAndParkHumanGate();
    const forged = await runCLI(["workflow", "gate", "approve", runId, "lead", "--actor", "human"], root);
    expect(forged.code).not.toBe(0);
    const status = await runCLI(["workflow", "status", runId], root);
    expect(status.stdout).toMatch(/lead/); // still awaiting the gate
  });

  it("FAILS non-zero with --actor agent on a human gate and satisfies nothing", async () => {
    const runId = await startAndParkHumanGate();
    const bad = await runCLI(["workflow", "gate", "approve", runId, "lead", "--actor", "agent"], root);
    expect(bad.code).not.toBe(0);
    const status = await runCLI(["workflow", "status", runId], root);
    expect(status.stdout).toMatch(/lead/); // still awaiting the gate
  });
});

describe("workflow advance / cancel edge cases", () => {
  it("parks awaiting-output (exit 0) advancing onto a write-declaring stage", async () => {
    await installWorkflowProfile(
      root,
      buildWorkflowProfile([{ id: "draft", reads: ["ideas"], writes: ["ideas"] }]),
    );
    const runId = await startRun();
    const result = await runCLI(["workflow", "advance", runId], root);
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/awaiting-output/i);
  });

  it("cancels a run mid-run", async () => {
    await installGatedProfile();
    const runId = await startRun();
    const cancel = await runCLI(["workflow", "cancel", runId], root);
    expect(cancel.code).toBe(0);
    const status = await runCLI(["workflow", "status", runId], root);
    expect(status.stdout).toMatch(/cancelled|historical/);
  });

  it("exits non-zero for a bogus run id on advance/cancel/gate approve", async () => {
    await installGatedProfile();
    const bogus = "build-2026-01-01-9999";
    expect((await runCLI(["workflow", "advance", bogus], root)).code).not.toBe(0);
    expect((await runCLI(["workflow", "cancel", bogus], root)).code).not.toBe(0);
    expect((await runCLI(["workflow", "gate", "approve", bogus, "lead"], root)).code).not.toBe(0);
  });
});

describe("workflow fail / resume (BUG 1: failed is reachable + retryable)", () => {
  it("fails a run with --detail (terminal failed), then resumes it back to running", async () => {
    await installGatedProfile();
    const runId = await startRun();
    const failed = await runCLI(["workflow", "fail", runId, "--detail", "boom"], root);
    expect(failed.code).toBe(0);
    expect(failed.stdout).toMatch(/failed/i);
    const resumed = await runCLI(["workflow", "resume", runId], root);
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toMatch(/running/i);
  });

  it("exits non-zero failing a bogus run id", async () => {
    await installGatedProfile();
    expect((await runCLI(["workflow", "fail", "build-2026-01-01-9999"], root)).code).not.toBe(0);
  });
});
