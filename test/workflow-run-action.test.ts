/**
 * @file test/workflow-run-action.test.ts
 * @description ADVERSARIAL authority tests for `runAction` — the execution core.
 *
 * The invariant under test: an action can NEVER perform an operation its COMPOSED
 * effective permission does not meet. A read-only surface (tightened via local
 * config) cannot mutate run state; `mcp`/`viewer` (hard-capped at staged-write)
 * can never satisfy a human gate; a `disabled` effective permission denies
 * everything. Conversely, a sufficiently-authorized invocation runs and its
 * run-state effect (a run minted / advanced / cancelled / gate satisfied) is
 * asserted on the persisted record. Capability comparison is ordinal, so a
 * read-only surface failing a staged-write op is a denial, not a coincidence.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { installRunActionProfile, runActionProfile, plantLocalConfig } from "./fixtures/run-action-profile.js";
import { runAction } from "../src/workflows/run-action.js";
import { ActionDeniedError, UnknownActionError } from "../src/workflows/errors.js";
import { startWorkflow } from "../src/workflows/start.js";
import { advanceWorkflow } from "../src/workflows/advance.js";
import { readRun, listRuns } from "../src/workflows/store.js";
import type { HumanGateIo } from "../src/workflows/human-gate-confirm.js";
import type { WorkflowRun } from "../src/workflows/types.js";
import type { ActionSurface } from "../src/profile/types.js";

/** An INTERACTIVE fake IO that retypes the echoed token — the only way to satisfy a human gate. */
function interactiveIo(): HumanGateIo {
  let captured = "";
  return {
    stdinIsTty: true,
    stdoutIsTty: true,
    write: (text) => {
      captured += text;
    },
    readLine: async () => (captured.match(/terminal: ([0-9a-f]+)/) ?? ["", ""])[1],
  };
}

/** Re-read the persisted run, failing the test if it is not available. */
async function loadRun(root: string, runId: string): Promise<WorkflowRun> {
  const read = await readRun(root, runId);
  if (read.status !== "ok") throw new Error(`run not ok: ${read.status}`);
  return read.run;
}

/** Install the action profile under a fresh temp root (optionally with a local config). */
async function setup(prefix: string, config?: Record<string, unknown>): Promise<string> {
  const root = await makeTempRoot(prefix);
  await installRunActionProfile(root);
  if (config) await plantLocalConfig(root, config);
  return root;
}

/** Operator-set human-gate enablement env var (C2: out-of-workspace anchor). */
const ENABLED_GATES_ENV = "LLMWIKI_ENABLED_HUMAN_GATES";

afterEach(() => {
  delete process.env[ENABLED_GATES_ENV];
});

/** Enable a human gate the way the OPERATOR does — out of the workspace, via the env var. */
function operatorEnableGate(gate: string): void {
  process.env[ENABLED_GATES_ENV] = gate;
}

/** Start a gated `workflowId` run and advance once so its gate is parked. */
async function startAndPark(root: string, workflowId: string): Promise<string> {
  const run = await startWorkflow(root, workflowId, {});
  await advanceWorkflow(root, run.runId);
  return run.runId;
}

/** Run `build.start` on cli and assert it was DENIED with NO run minted. */
async function expectStartDeniedNoRun(root: string): Promise<void> {
  await expect(runAction(root, "build.start", {}, "cli")).rejects.toBeInstanceOf(ActionDeniedError);
  expect(await listRuns(root)).toEqual({ status: "ok", runIds: [] });
}

/** Park a gate, run the gate action on `surface`, and assert it was DENIED with no gate satisfied. */
async function expectGateDenied(root: string, workflowId: string, actionId: string, surface: ActionSurface): Promise<void> {
  const runId = await startAndPark(root, workflowId);
  await expect(runAction(root, actionId, { runId }, surface)).rejects.toBeInstanceOf(ActionDeniedError);
  expect((await loadRun(root, runId)).satisfiedGates).toEqual([]);
}

describe("runAction — status under read-only", () => {
  it("runs a status action with a read-only effective permission", async () => {
    const root = await setup("ra-status", { workflowGrants: { cli: "read-only" } });
    const result = await runAction(root, "build.status", {}, "cli");
    expect(result.effectivePermission).toBe("read-only");
    expect(Array.isArray(result.result)).toBe(true);
  });
});

describe("runAction — mutating ops require staged-write", () => {
  it("DENIES start on a read-only-tightened surface and mints no run", async () => {
    const root = await setup("ra-start-ro", { workflowGrants: { cli: "read-only" } });
    await expectStartDeniedNoRun(root);
  });

  it("RUNS start with staged-write and mints a pending run", async () => {
    const root = await setup("ra-start-ok", { workflowGrants: { cli: "staged-write" } });
    const result = await runAction(root, "build.start", {}, "cli");
    expect(result.effectivePermission).toBe("staged-write");
    expect((result.result as WorkflowRun).status).toBe("pending");
  });

  it("DENIES advance on read-only and leaves the run unadvanced", async () => {
    const root = await setup("ra-adv-ro", { workflowGrants: { cli: "read-only" } });
    const runId = await startAndPark(root, "build");
    const before = await loadRun(root, runId);
    await expect(runAction(root, "build.advance", { runId }, "cli")).rejects.toBeInstanceOf(ActionDeniedError);
    expect((await loadRun(root, runId)).stateVersion).toBe(before.stateVersion);
  });

  it("RUNS advance with staged-write, executing the advance op (run becomes running)", async () => {
    // The `draft` stage declares writes, so advance PARKS it awaiting an output —
    // the run-state effect proving the advance executed is the pending→running flip.
    const root = await setup("ra-adv-ok", { workflowGrants: { cli: "staged-write" } });
    const run = await startWorkflow(root, "build", {});
    const result = await runAction(root, "build.advance", { runId: run.runId }, "cli");
    expect(result.effectivePermission).toBe("staged-write");
    expect((await loadRun(root, run.runId)).status).toBe("running");
  });

  it("RUNS cancel with staged-write, moving the run to cancelled", async () => {
    const root = await setup("ra-cancel-ok", { workflowGrants: { cli: "staged-write" } });
    const run = await startWorkflow(root, "build", {});
    await runAction(root, "build.cancel", { runId: run.runId }, "cli");
    expect((await loadRun(root, run.runId)).status).toBe("cancelled");
  });

  // BUG 1 (H2): the `fail` action routes a run to terminal `failed` + run-failed event.
  it("RUNS fail with staged-write, moving the run to failed with the detail recorded", async () => {
    const root = await setup("ra-fail-ok", { workflowGrants: { cli: "staged-write" } });
    const run = await startWorkflow(root, "build", {});
    await runAction(root, "build.fail", { runId: run.runId, detail: "boom" }, "cli");
    const failed = await loadRun(root, run.runId);
    expect(failed.status).toBe("failed");
    expect(failed.events.at(-1)).toMatchObject({ type: "run-failed", detail: "boom" });
  });

  it("DENIES fail on a read-only-tightened surface and leaves the run unfailed", async () => {
    const root = await setup("ra-fail-ro", { workflowGrants: { cli: "read-only" } });
    const run = await startWorkflow(root, "build", {});
    await expect(runAction(root, "build.fail", { runId: run.runId }, "cli")).rejects.toBeInstanceOf(ActionDeniedError);
    expect((await loadRun(root, run.runId)).status).not.toBe("failed");
  });
});

describe("runAction — human gate (FIX A: unified interactive proof)", () => {
  it("SATISFIES a human gate on cli ONLY via the interactive proof (operator-enabled)", async () => {
    const root = await setup("ra-human-ok");
    operatorEnableGate("human:approve");
    const runId = await startAndPark(root, "humanwf");
    await runAction(root, "gatehuman.approve", { runId }, "cli", interactiveIo());
    expect((await loadRun(root, runId)).satisfiedGates).toContain("human:approve");
  });

  it("DENIES a human gate on cli NON-interactively (the action-surface bypass is dead)", async () => {
    // An agent that pipes `action run gatehuman.approve` is NON-interactive: the
    // default non-interactive IO fails the proof, so the gate is DENIED even when
    // operator-enabled. This is the C1 action-surface bypass, now closed.
    const root = await setup("ra-human-cli-noninteractive");
    operatorEnableGate("human:approve");
    await expectGateDenied(root, "humanwf", "gatehuman.approve", "cli");
  });

  it("DENIES a human gate on sdk even with an interactive-looking IO (programmatic surface)", async () => {
    const root = await setup("ra-human-sdk");
    operatorEnableGate("human:approve");
    const runId = await startAndPark(root, "humanwf");
    await expect(runAction(root, "gatehuman.approve", { runId }, "sdk", interactiveIo())).rejects.toBeInstanceOf(ActionDeniedError);
    expect((await loadRun(root, runId)).satisfiedGates).toEqual([]);
  });

  it("DENIES a human gate on mcp (hard-capped staged-write) even when operator-enabled", async () => {
    const root = await setup("ra-human-mcp");
    operatorEnableGate("human:approve");
    await expectGateDenied(root, "humanwf", "gatehuman.approve", "mcp");
  });

  it("DENIES a human gate on viewer (hard-capped staged-write)", async () => {
    const root = await setup("ra-human-viewer");
    operatorEnableGate("human:approve");
    await expectGateDenied(root, "humanwf", "gatehuman.approve", "viewer");
  });

  it("DENIES a human gate on cli WITHOUT operator enablement (env var unset)", async () => {
    const root = await setup("ra-human-noenable");
    await expect(runAction(root, "gatehuman.approve", { runId: await startAndPark(root, "humanwf") }, "cli", interactiveIo())).rejects.toBeInstanceOf(ActionDeniedError);
  });

  it("DENIES a human gate self-enabled via the workspace config (C2 exploit is dead)", async () => {
    // The agent writes enabledHumanGates into its own .llmwiki/config.json — the C2
    // exploit. With enablement moved out-of-workspace it is IGNORED, so the gate
    // stays denied without the operator's env var.
    const root = await setup("ra-human-selfenable", { enabledHumanGates: ["human:approve"] });
    operatorEnableGate("human:other"); // operator enabled a DIFFERENT gate, not this one
    await expect(runAction(root, "gatehuman.approve", { runId: await startAndPark(root, "humanwf") }, "cli", interactiveIo())).rejects.toBeInstanceOf(ActionDeniedError);
  });
});

describe("runAction — agent gate", () => {
  it("SATISFIES an agent gate with staged-write (agent actor)", async () => {
    const root = await setup("ra-agent-ok", { workflowGrants: { cli: "staged-write" } });
    const runId = await startAndPark(root, "agentwf");
    await runAction(root, "gateagent.check", { runId }, "cli");
    expect((await loadRun(root, runId)).satisfiedGates).toContain("agent:check");
  });

  it("DENIES an agent gate with a read-only effective permission", async () => {
    const root = await setup("ra-agent-ro", { workflowGrants: { cli: "read-only" } });
    await expectGateDenied(root, "agentwf", "gateagent.check", "cli");
  });
});

describe("runAction — disabled + unknown", () => {
  it("DENIES every operation when the profile permission is disabled", async () => {
    const profile = runActionProfile();
    profile.workflowActions!["build.start"].permissions = { cli: "disabled", sdk: "disabled", mcp: "disabled", viewer: "disabled" };
    const root = await makeTempRoot("ra-disabled");
    await installRunActionProfile(root, profile);
    await expectStartDeniedNoRun(root);
  });

  it("throws UnknownActionError for an undeclared id and a prototype-chain id", async () => {
    const root = await setup("ra-unknown");
    await expect(runAction(root, "ghost.op", {}, "cli")).rejects.toBeInstanceOf(UnknownActionError);
    await expect(runAction(root, "constructor", {}, "cli")).rejects.toBeInstanceOf(UnknownActionError);
  });
});
