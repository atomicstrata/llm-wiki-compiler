/**
 * @file test/workflow-gate.test.ts
 * @description Behavioural tests for the `approveGate` run-lifecycle operation.
 *
 * Covers gate approval with strict actor-kind enforcement: a `human:` gate is
 * satisfiable only by a human (an agent is rejected, writing nothing); an
 * `agent:` gate is satisfiable by an agent OR a human but not by `system`;
 * approving clears the stage's `awaiting-gate` park (so a subsequent `advance`
 * steps past it) and records a `gate-approved` event. Also covers the fail-closed
 * guards: unknown gate id, `trust:` gates (handled in the next slice), terminal
 * runs, idempotent re-approval, and lock contention.
 */

import { describe, it, expect } from "vitest";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { buildWorkflowProfile, installWorkflowProfile, startAndParkBuild as startAndPark } from "./fixtures/workflow-profile.js";
import { startWorkflow } from "../src/workflows/start.js";
import { advanceWorkflow } from "../src/workflows/advance.js";
import { cancelWorkflow } from "../src/workflows/cancel.js";
import { approveGate } from "../src/workflows/gate.js";
import { readRun } from "../src/workflows/store.js";
import {
  RunNotActiveError,
  UnknownGateError,
  GateActorMismatchError,
  TrustGateNotHereError,
} from "../src/workflows/errors.js";
import { acquireLock, releaseLock, LockBusyError } from "../src/utils/lock.js";
import { WorkflowFieldTooLongError } from "../src/workflows/field-limits.js";
import { MAX_WORKFLOW_LABEL_CHARS } from "../src/utils/constants.js";
import type { WorkflowStageDef } from "../src/profile/types.js";

/** Re-read the persisted run, failing the test if it is not available. */
async function loadRun(root: string, runId: string) {
  const read = await readRun(root, runId);
  if (read.status !== "ok") throw new Error(`run not ok: ${read.status}`);
  return read.run;
}

/** Assert the run recorded NO gate approval: no satisfied gate, no `gate-approved` event. */
async function expectNoGateApproval(root: string, runId: string): Promise<void> {
  const run = await loadRun(root, runId);
  expect(run.satisfiedGates).toEqual([]);
  expect(run.events.filter((e) => e.type === "gate-approved")).toHaveLength(0);
}

/** A two-stage workflow whose first stage carries `gate`. */
function gatedStages(gate: string): WorkflowStageDef[] {
  return [
    { id: "review", reads: ["ideas"], writes: [], gate },
    { id: "publish", reads: ["experiments"], writes: [] },
  ];
}

describe("approveGate — human gate", () => {
  it("a human approves a human: gate, clearing the park so advance steps past it", async () => {
    const { root, runId } = await startAndPark("wf-gate-human-ok", gatedStages("human:approve"));
    const run = await approveGate(root, runId, "approve", { actorKind: "human" });
    expect(run.satisfiedGates).toContain("human:approve");
    expect(run.stageLog[0]).toEqual({ stageId: "review", status: "running" });
    expect(run.events.filter((e) => e.type === "gate-approved")).toHaveLength(1);
    const advanced = await advanceWorkflow(root, runId);
    expect(advanced.outcome).toBe("advanced");
    expect(advanced.run.currentStage).toBe("publish");
  });

  it("an agent CANNOT satisfy a human: gate and nothing is written", async () => {
    const { root, runId } = await startAndPark("wf-gate-human-agent", gatedStages("human:approve"));
    await expect(approveGate(root, runId, "approve", { actorKind: "agent" })).rejects.toBeInstanceOf(
      GateActorMismatchError,
    );
    await expectNoGateApproval(root, runId);
  });
});

describe("approveGate — agent gate", () => {
  it("an agent satisfies an agent: gate", async () => {
    const { root, runId } = await startAndPark("wf-gate-agent-agent", gatedStages("agent:check"));
    const run = await approveGate(root, runId, "check", { actorKind: "agent" });
    expect(run.satisfiedGates).toContain("agent:check");
  });

  it("a human may also satisfy an agent: gate", async () => {
    const { root, runId } = await startAndPark("wf-gate-agent-human", gatedStages("agent:check"));
    const run = await approveGate(root, runId, "check", { actorKind: "human" });
    expect(run.satisfiedGates).toContain("agent:check");
  });

  it("a system actor CANNOT satisfy an agent: gate", async () => {
    const { root, runId } = await startAndPark("wf-gate-agent-system", gatedStages("agent:check"));
    await expect(approveGate(root, runId, "check", { actorKind: "system" })).rejects.toBeInstanceOf(
      GateActorMismatchError,
    );
  });
});

describe("approveGate — actor-label cap (FIX 2)", () => {
  it("rejects an over-long actorLabel (typed) and writes nothing", async () => {
    const { root, runId } = await startAndPark("wf-gate-label-cap", gatedStages("human:approve"));
    const label = "x".repeat(MAX_WORKFLOW_LABEL_CHARS + 1);
    await expect(
      approveGate(root, runId, "approve", { actorKind: "human", actorLabel: label }),
    ).rejects.toBeInstanceOf(WorkflowFieldTooLongError);
    await expectNoGateApproval(root, runId);
  });
});

describe("approveGate — fail-closed guards", () => {
  it("throws UnknownGateError when the current stage declares no such gate", async () => {
    const { root, runId } = await startAndPark("wf-gate-unknown", gatedStages("human:approve"));
    await expect(approveGate(root, runId, "nope", { actorKind: "human" })).rejects.toBeInstanceOf(
      UnknownGateError,
    );
  });

  it("throws TrustGateNotHereError for a trust: gate", async () => {
    // `gate approve` rejects a trust: gate regardless of advance state (a trust
    // gate is cleared only by the Trust-Guard apply), so approve without advancing.
    // A `trust:` stage requires non-empty `writes` to load (M2), so the gated
    // stage declares a write here.
    const root = await makeTempRoot("wf-gate-trust");
    const trustStages: WorkflowStageDef[] = [
      { id: "review", reads: ["ideas"], writes: ["experiments"], gate: "trust:high" },
      { id: "publish", reads: ["experiments"], writes: [] },
    ];
    await installWorkflowProfile(root, buildWorkflowProfile(trustStages));
    const run = await startWorkflow(root, "build", {});
    await expect(approveGate(root, run.runId, "high", { actorKind: "human" })).rejects.toBeInstanceOf(
      TrustGateNotHereError,
    );
  });

  it("throws RunNotActiveError when approving on a terminal (cancelled) run", async () => {
    const { root, runId } = await startAndPark("wf-gate-terminal", gatedStages("human:approve"));
    await cancelWorkflow(root, runId);
    await expect(approveGate(root, runId, "approve", { actorKind: "human" })).rejects.toBeInstanceOf(
      RunNotActiveError,
    );
  });

  it("throws LockBusyError after the bounded timeout when the lock stays held (not immediately)", async () => {
    const { root, runId } = await startAndPark("wf-gate-busy", gatedStages("human:approve"));
    expect(await acquireLock(root, { quiet: true })).toBe(true);
    try {
      // Bounded-blocking: retries then throws after the short timeout (consistent contract).
      await expect(approveGate(root, runId, "approve", { actorKind: "human" }, { timeoutMs: 60, intervalMs: 5 })).rejects.toBeInstanceOf(
        LockBusyError,
      );
    } finally {
      await releaseLock(root);
    }
  });
});

describe("approveGate — idempotency", () => {
  it("re-approving the same human gate is a no-op (no version/event churn)", async () => {
    const { root, runId } = await startAndPark("wf-gate-idem", gatedStages("human:approve"));
    const first = await approveGate(root, runId, "approve", { actorKind: "human" });
    const versionAfter = first.stateVersion;
    const eventsAfter = first.events.length;
    const second = await approveGate(root, runId, "approve", { actorKind: "human" });
    expect(second.stateVersion).toBe(versionAfter);
    expect(second.events.length).toBe(eventsAfter);
  });
});
